import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { delimiter, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import process from "node:process"
import {
  CliExecutableError, createCliTransport, findExecutable, nativeObservedUsageCanonicalByteBound, type CliEngine,
} from "../src/hosts/cli-transport.ts"
import { codexProfileArgv, createCodexProfile } from "../src/hosts/codex-profile.ts"

const CODEX_MODEL = "gpt-5.6-sol"

const testDirectories: string[] = []
const restoreEnvironment: Array<() => void> = []

afterEach(() => {
  for (const restore of restoreEnvironment.splice(0).reverse()) restore()
  for (const directory of testDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function installFakeCli(engine: CliEngine, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cli-transport-test-"))
  testDirectories.push(directory)
  const executable = join(directory, engine === "local" ? "ollama" : engine)
  writeFileSync(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  chmodSync(executable, 0o700)
  const previousPath = process.env.PATH
  restoreEnvironment.push(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })
  process.env.PATH = directory
  return directory
}

function createPathDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "cli-transport-path-test-"))
  testDirectories.push(directory)
  return directory
}

function setPath(directories: string[]): void {
  const previousPath = process.env.PATH
  restoreEnvironment.push(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })
  process.env.PATH = directories.join(delimiter)
}

function setProcessPlatform(value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  if (!descriptor?.configurable) throw new Error("process.platform is not configurable for this regression")
  Object.defineProperty(process, "platform", { ...descriptor, value })
  restoreEnvironment.push(() => Object.defineProperty(process, "platform", descriptor))
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 5))
  if (!existsSync(path)) throw new Error("fixture process did not create its start marker")
}

function fixtureSource(options: {
  expectedArgs: string[]
  prompt: string
  chunks: string[]
  marker: string
  sourceRoot: string
  linger?: boolean
  replaceScratch?: boolean
  replaceCatalog?: boolean
  version?: string
  versionMarker?: string
  versionLinger?: boolean
  invocationMarker?: string
  descendantDelayMs?: number
  profileCatalog?: { name: string; contents: string }
}): string {
  return `
const fs = require("node:fs")
const path = require("node:path")
const expectedArgs = ${JSON.stringify(options.expectedArgs)}
const expectedPrompt = ${JSON.stringify(options.prompt)}
const chunks = ${JSON.stringify(options.chunks)}
let prompt = ""
;(async () => {
  for await (const chunk of process.stdin) prompt += chunk.toString("utf8")
  const rawArgs = process.argv.slice(2)
  if (rawArgs.length === 1 && rawArgs[0] === "--version" && ${JSON.stringify(options.version ?? "")}) {
    ${options.invocationMarker === undefined ? "" : `fs.appendFileSync(${JSON.stringify(options.invocationMarker)}, JSON.stringify({ argv: rawArgs, cwd: process.cwd() }) + "\\n")`}
    ${options.versionMarker === undefined ? "" : `fs.writeFileSync(${JSON.stringify(options.versionMarker)}, JSON.stringify({ cwd: process.cwd() }))`}
    process.stdout.write(${JSON.stringify(options.version ?? "")} + "\\n")
    ${options.versionLinger === true ? 'setInterval(() => process.stdout.write("."), 10)' : ""}
    return
  }
  const cwd = process.cwd()
  const profileRoot = path.dirname(cwd)
  const args = rawArgs.map(arg => arg.replaceAll(cwd, "/__PROFILE__/workdir").replaceAll(profileRoot, "/__PROFILE__"))
  const sourceRoot = ${JSON.stringify(options.sourceRoot)}
  const isInsideSource = cwd === sourceRoot || cwd.startsWith(sourceRoot + path.sep)
  if (JSON.stringify(args) !== JSON.stringify(expectedArgs) || prompt !== expectedPrompt || isInsideSource || fs.readdirSync(cwd).length !== 0) {
    process.stderr.write("fixture contract failed")
    process.exitCode = 9
    return
  }
  ${options.invocationMarker === undefined ? "" : `fs.appendFileSync(${JSON.stringify(options.invocationMarker)}, JSON.stringify({ argv: rawArgs, cwd }) + "\\n")`}
  if (${JSON.stringify(options.profileCatalog ?? null)}) {
    const profileEntries = fs.readdirSync(profileRoot).sort()
    const expectedEntries = ["workdir", ${JSON.stringify(options.profileCatalog?.name ?? "")}].sort()
    const catalogPath = path.join(profileRoot, ${JSON.stringify(options.profileCatalog?.name ?? "")})
    if (JSON.stringify(profileEntries) !== JSON.stringify(expectedEntries) ||
        !fs.lstatSync(catalogPath).isFile() || fs.lstatSync(catalogPath).isSymbolicLink() ||
        (fs.statSync(catalogPath).mode & 0o777) !== 0o600 ||
        fs.readFileSync(catalogPath, "utf8") !== ${JSON.stringify(options.profileCatalog?.contents ?? "")}) {
      process.stderr.write("fixture profile contract failed")
      process.exitCode = 11
      return
    }
  }
  if (${options.replaceScratch === true}) {
    const originalPath = cwd + ".original"
    fs.renameSync(cwd, originalPath)
    fs.mkdirSync(cwd, { mode: 0o700 })
    fs.writeFileSync(path.join(cwd, "sentinel"), "preserve replacement")
    fs.writeFileSync(${JSON.stringify(options.marker)}, JSON.stringify({ cwd, profileRoot, originalPath, prompt, argv: rawArgs }))
  } else if (${options.replaceCatalog === true}) {
    const catalogPath = path.join(profileRoot, ${JSON.stringify(options.profileCatalog?.name ?? "")})
    const originalCatalogPath = catalogPath + ".original"
    fs.renameSync(catalogPath, originalCatalogPath)
    fs.writeFileSync(catalogPath, "preserve replacement catalog", { mode: 0o600 })
    fs.writeFileSync(${JSON.stringify(options.marker)}, JSON.stringify({ cwd, profileRoot, catalogPath, originalCatalogPath, prompt, argv: rawArgs }))
  } else {
    fs.writeFileSync(${JSON.stringify(options.marker)}, JSON.stringify({ cwd, profileRoot, prompt, argv: rawArgs }))
  }
  ${options.descendantDelayMs === undefined ? "" : `const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), ${options.descendantDelayMs})"], { stdio: "inherit" })\ndescendant.unref()`}
  for (const chunk of chunks) process.stdout.write(chunk)
  ${options.linger ? 'setInterval(() => process.stdout.write("."), 10)' : ""}
})().catch(() => { process.exitCode = 10 })
`
}

function sourceRoot(): string {
  return resolve(import.meta.dir, "../..")
}

function options(engine: CliEngine, overrides: Partial<Parameters<typeof createCliTransport>[0]> = {}) {
  return {
    engine,
    model: engine === "codex" ? CODEX_MODEL : "test-model:tag",
    prompt: "fixture prompt",
    deadlineAt: Date.now() + 5000,
    maxOutputBytes: 1024,
    ...overrides,
  }
}

function codexExpectedArgs(): string[] {
  const profile = createCodexProfile(CODEX_MODEL)
  const scratch = "/__PROFILE__/workdir"
  const catalog = `/__PROFILE__/codex-${profile.version}-catalog.json`
  return [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "-C", scratch, "-m", CODEX_MODEL, ...codexProfileArgv(profile, scratch, catalog),
    "-c", "features.shell_tool=false", "-c", "features.multi_agent=false", "-c", "web_search=disabled",
    "-c", "features.view_image=false", "-c", "features.sleep_tool=false", "-c", "features.apps=false",
    "-c", "features.plugins=false", "-c", "include_environment_context=false", "-c", "project_doc_max_bytes=0",
    "-c", "mcp_servers={}", "-",
  ]
}

function claudeOutput(text: string, plugins?: unknown): string[] {
  const session = "claude-session-fixture"
  return [
    `${JSON.stringify({ type: "system", subtype: "init", session_id: session, ...(plugins === undefined ? {} : { plugins }) })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { type: "message", role: "assistant", content: [], stop_reason: null } }, session_id: session })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: session })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: session })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: session })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, session_id: session })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "message_stop" }, session_id: session })}\n`,
    `${JSON.stringify({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } })}\n`,
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, permission_denials: [], result: text, session_id: session })}\n`,
  ]
}

function claudeRateLimitOutput(event: Record<string, unknown>): string[] {
  const frames = claudeOutput("READY")
  frames.splice(-1, 0, `${JSON.stringify(event)}\n`)
  return frames
}

function claudeThinkingTokensOutput(
  event: Record<string, unknown>,
  placement: "after-init" | "before-init" | "after-terminal" = "after-init",
): string[] {
  const frames = claudeOutput("READY")
  const metadataFrame = `${JSON.stringify(event)}\n`
  if (placement === "before-init") {
    frames.unshift(metadataFrame)
  } else if (placement === "after-terminal") {
    const successResult = frames[frames.length - 1]!
    frames.push(metadataFrame, successResult)
  } else {
    frames.splice(1, 0, metadataFrame)
  }
  return frames
}

function thinkingTokensEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "thinking_tokens",
    session_id: "claude-session-fixture",
    estimated_tokens: 50,
    estimated_tokens_delta: 50,
    ...overrides,
  }
}

async function runClaudeFixture(chunks: string[]) {
  const expectedArgs = [
    "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", "test-model:tag",
  ]
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("claude", fixtureSource({ expectedArgs, prompt: "fixture prompt", chunks, marker, sourceRoot: sourceRoot() }))
  return createCliTransport(options("claude")).run()
}

function codexOutput(item: Record<string, unknown>, terminal: Record<string, unknown> = { type: "turn.completed", usage: {} }): string[] {
  return [
    `${JSON.stringify({ type: "thread.started", thread_id: "codex-thread-fixture" })}\n`,
    `${JSON.stringify({ type: "turn.started" })}\n`,
    `${JSON.stringify(item)}\n`,
    `${JSON.stringify(terminal)}\n`,
  ]
}

test("Claude reports only final observed usage and retains unknown fields instead of inventing zeros", async () => {
  const frames = claudeOutput("usage answer")
  const terminal = JSON.parse(frames[frames.length - 1]!)
  terminal.usage = { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 }
  terminal.total_cost_usd = 0.002
  frames[frames.length - 1] = `${JSON.stringify(terminal)}\n`
  expect((await runClaudeFixture(frames)).usage).toEqual({
    inputTokens: 12, outputTokens: 4, cachedInputTokens: 3, cacheCreationTokens: 0, reportedCostUsd: 0.002,
  })
  // Intermediate message_delta usage is not an aggregate counter.
  expect((await runClaudeFixture(claudeOutput("unknown usage"))).usage).toBeUndefined()
})

test("observed usage canonical byte bound covers normalized numeric edges and omits unknown vendor fields", async () => {
  const frames = claudeOutput("usage byte bound")
  const terminal = JSON.parse(frames[frames.length - 1]!)
  terminal.usage = {
    input_tokens: Number.MAX_SAFE_INTEGER,
    output_tokens: Number.MAX_SAFE_INTEGER,
    cache_read_input_tokens: Number.MAX_SAFE_INTEGER,
    cache_creation_input_tokens: Number.MAX_SAFE_INTEGER,
    future_vendor_counter: Number.MAX_SAFE_INTEGER,
  }
  terminal.total_cost_usd = Number.MAX_VALUE
  frames[frames.length - 1] = `${JSON.stringify(terminal)}\n`

  const usage = (await runClaudeFixture(frames)).usage
  if (!usage) throw new Error("normalized native CLI usage was omitted")
  expect(usage).toEqual({
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: Number.MAX_SAFE_INTEGER,
    cachedInputTokens: Number.MAX_SAFE_INTEGER,
    cacheCreationTokens: Number.MAX_SAFE_INTEGER,
    reportedCostUsd: Number.MAX_VALUE,
  })
  expect(nativeObservedUsageCanonicalByteBound()).toBe(191)
  const serializedUsage = JSON.stringify(usage)
  expect(Buffer.byteLength(serializedUsage, "utf8")).toBeLessThanOrEqual(nativeObservedUsageCanonicalByteBound())
  expect(serializedUsage).not.toContain("future_vendor_counter")
})

test("malformed or unreported usage stays unknown without coercion or cost invention", async () => {
  const frames = claudeOutput("partial usage")
  const terminal = JSON.parse(frames[frames.length - 1]!)
  terminal.usage = { input_tokens: "12", output_tokens: 0, cache_read_input_tokens: -1, cache_creation_input_tokens: 0.5 }
  terminal.total_cost_usd = "0.002"
  frames[frames.length - 1] = `${JSON.stringify(terminal)}\n`
  const usage = (await runClaudeFixture(frames)).usage
  if (!usage) throw new Error("valid observed output counter was omitted")
  expect(usage).toEqual({ outputTokens: 0 })
  const serializedUsage = JSON.stringify(usage)
  expect(serializedUsage).toBe('{"outputTokens":0}')
  expect(Buffer.byteLength(serializedUsage, "utf8")).toBeLessThanOrEqual(nativeObservedUsageCanonicalByteBound())
})

test("Codex retains its reported token counters without implying provider billing or retries", async () => {
  setProcessPlatform("darwin")
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  const profile = createCodexProfile(CODEX_MODEL)
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(), prompt: "fixture prompt", marker, sourceRoot: sourceRoot(),
    version: "codex-cli 0.163.0",
    profileCatalog: { name: `codex-${profile.version}-catalog.json`, contents: profile.catalogJson },
    chunks: codexOutput(
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "usage answer" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 } },
    ),
  }))
  const result = await createCliTransport(options("codex")).run()
  expect(result.status).toBe("completed")
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 })
})

function installIdentityFixture(engine: "codex" | "claude", modifyAfterDispatch = false, versionLinger = false) {
  setProcessPlatform("darwin")
  const root = mkdtempSync(join(tmpdir(), "cli-identity-test-"))
  testDirectories.push(root)
  const marker = join(root, "inference.json")
  const versionMarker = join(root, "version.json")
  const profile = createCodexProfile(CODEX_MODEL)
  const expectedArgs = engine === "codex" ? codexExpectedArgs() : [
    "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", "test-model:tag",
  ]
  let source = fixtureSource({
    expectedArgs, prompt: "fixture prompt", marker, versionMarker, versionLinger, sourceRoot: sourceRoot(),
    version: engine === "codex" ? "codex-cli 0.163.0" : "2.1.301 (Claude Code)",
    ...(engine === "codex" ? { profileCatalog: { name: `codex-${profile.version}-catalog.json`, contents: profile.catalogJson } } : {}),
    chunks: engine === "codex"
      ? codexOutput({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "identity answer" } })
      : claudeOutput("identity answer"),
  })
  if (modifyAfterDispatch) source = source.replace("for (const chunk of chunks)", 'fs.appendFileSync(process.argv[1], "\\n// runtime changed\\n"); for (const chunk of chunks)')
  const directory = installFakeCli(engine, source)
  return { marker, versionMarker, executable: join(directory, engine), handle: createCliTransport(options(engine)) }
}

test.each(["codex", "claude"] as const)("%s identity inspection observes version and pinned bytes without inference", async engine => {
  const fixture = installIdentityFixture(engine)
  const identity = await fixture.handle.inspectIdentity!()
  expect(identity).toMatchObject({
    engine, requestedModel: options(engine).model,
    runtimeIdentity: {
      version: engine === "codex" ? "0.163.0" : "2.1.301",
      executableSha256: createHash("sha256").update(readFileSync(fixture.executable)).digest("hex"),
    },
  })
  expect(existsSync(fixture.versionMarker)).toBe(true)
  expect(existsSync(fixture.marker)).toBe(false)
  if (engine === "codex") expect(identity!.profileIdentity.sha256).toBe(createCodexProfile(CODEX_MODEL).catalogHash)
  expect(await fixture.handle.run()).toMatchObject({ status: "completed", text: "identity answer", quiescent: true })
  expect(await fixture.handle.inspectIdentity!()).toEqual(identity)
})

test("post-run identity cannot invent pre-dispatch observation and refuses later executable drift", async () => {
  const unobserved = installIdentityFixture("claude")
  expect((await unobserved.handle.run()).status).toBe("completed")
  expect(await unobserved.handle.inspectIdentity!()).toBeUndefined()
  const observed = installIdentityFixture("claude")
  expect(await observed.handle.inspectIdentity!()).toBeDefined()
  expect((await observed.handle.run()).status).toBe("completed")
  writeFileSync(observed.executable, `${readFileSync(observed.executable, "utf8")}\n// changed after dispatch\n`)
  expect(await observed.handle.inspectIdentity!()).toBeUndefined()
})

test.each(["codex", "claude"] as const)("%s refuses executable drift after identity inspection before inference", async engine => {
  const fixture = installIdentityFixture(engine)
  expect(await fixture.handle.inspectIdentity!()).toBeDefined()
  writeFileSync(fixture.executable, `${readFileSync(fixture.executable, "utf8")}\n// changed before dispatch\n`)
  expect(await fixture.handle.run()).toMatchObject({ status: "failed", quiescent: true, error: "native runtime identity verification failed" })
  expect(existsSync(fixture.marker)).toBe(false)
})

test.each(["codex", "claude"] as const)("%s refuses successful output when executable changes during dispatch", async engine => {
  const fixture = installIdentityFixture(engine, true)
  expect(await fixture.handle.inspectIdentity!()).toBeDefined()
  expect(await fixture.handle.run()).toMatchObject({ status: "failed", quiescent: true, error: "native runtime identity verification failed" })
  expect(existsSync(fixture.marker)).toBe(true)
})

test("identity inspection supports read-only installed hard-links but refuses changes through aliases", async () => {
  const fixture = installIdentityFixture("claude")
  const alias = `${fixture.executable}-package-cache`
  fs.linkSync(fixture.executable, alias)
  expect(await fixture.handle.inspectIdentity!()).toBeDefined()
  writeFileSync(alias, `${readFileSync(alias, "utf8")}\n// package cache changed\n`)
  expect(await fixture.handle.run()).toMatchObject({ status: "failed", quiescent: true, error: "native runtime identity verification failed" })
  expect(existsSync(fixture.marker)).toBe(false)
})

test("cancelling an owned identity probe prevents subsequent inference", async () => {
  const fixture = installIdentityFixture("claude", false, true)
  const inspection = fixture.handle.inspectIdentity!()
  await waitForPath(fixture.versionMarker)
  expect((await fixture.handle.requestCancel("fixture cancellation", Date.now() + 2000)).requested).toBe(true)
  expect(await inspection).toBeUndefined()
  expect(await fixture.handle.run()).toMatchObject({ status: "cancelled", quiescent: true })
  expect(existsSync(fixture.marker)).toBe(false)
})

test.each(["codex", "claude"] as const)("findExecutable reports permission denial for a non-executable %s file", engine => {
  const directory = createPathDirectory()
  const candidate = join(directory, engine)
  writeFileSync(candidate, "", { mode: 0o600 })
  chmodSync(candidate, 0o600)
  setPath([directory])

  let thrown: unknown
  try { findExecutable(engine) } catch (error) { thrown = error }

  expect(thrown).toBeInstanceOf(CliExecutableError)
  expect(thrown).toMatchObject({ reason: "permission-denied", message: "CLI executable permission denied" })
  expect((thrown as Error).message).not.toContain(directory)
})

test.each(["codex", "claude"] as const)("findExecutable preserves the legacy not-found error for absent %s", engine => {
  setPath([createPathDirectory()])

  let thrown: unknown
  try { findExecutable(engine) } catch (error) { thrown = error }

  expect(thrown).toBeInstanceOf(CliExecutableError)
  expect(thrown).toMatchObject({ reason: "not-found", message: "CLI executable not found" })
})

test.each(["codex", "claude"] as const)("findExecutable skips a denied %s candidate when a later PATH candidate is usable", engine => {
  const deniedDirectory = createPathDirectory()
  const usableDirectory = createPathDirectory()
  const deniedCandidate = join(deniedDirectory, engine)
  const usableCandidate = join(usableDirectory, engine)
  writeFileSync(deniedCandidate, "", { mode: 0o600 })
  chmodSync(deniedCandidate, 0o600)
  writeFileSync(usableCandidate, "", { mode: 0o700 })
  chmodSync(usableCandidate, 0o700)
  setPath([deniedDirectory, usableDirectory])

  expect(findExecutable(engine)).toBe(realpathSync(usableCandidate))
})

test("findExecutable rejects WSL Windows paths after resolving PATH entries and symlinks", async () => {
  const moduleSpecifier: string = "../src/hosts/cli-transport.ts?wsl-path-resolution-test"
  const wslTransport = await import(moduleSpecifier) as typeof import("../src/hosts/cli-transport.ts")
  setProcessPlatform("linux")

  const readFile = spyOn(fs, "readFileSync").mockImplementation((() => "microsoft") as unknown as typeof fs.readFileSync)
  const originalPathResolve = path.resolve
  const resolvePath = spyOn(path, "resolve").mockImplementation((...segments) =>
    segments[0] === "." ? "/mnt/c/fake/codex" : originalPathResolve(...segments))
  const inspectedCandidates: string[] = []
  const originalStat = fs.statSync
  const stat = spyOn(fs, "statSync").mockImplementation(((candidate: fs.PathLike) => {
    inspectedCandidates.push(String(candidate))
    return originalStat(candidate)
  }) as typeof fs.statSync)
  try {
    setPath(["."])
    expect(() => wslTransport.findExecutable("codex")).toThrow("CLI executable not found")
    expect(readFile).toHaveBeenCalledWith("/proc/sys/kernel/osrelease", "utf8")
    expect(inspectedCandidates).toEqual([])
  } finally {
    stat.mockRestore()
    resolvePath.mockRestore()
    readFile.mockRestore()
  }

  const deniedDirectory = createPathDirectory()
  const usableDirectory = createPathDirectory()
  const deniedCandidate = join(deniedDirectory, "codex")
  const usableCandidate = join(usableDirectory, "codex")
  writeFileSync(deniedCandidate, "", { mode: 0o700 })
  chmodSync(deniedCandidate, 0o700)
  writeFileSync(usableCandidate, "", { mode: 0o700 })
  chmodSync(usableCandidate, 0o700)
  const usableRealpath = realpathSync(usableCandidate)
  setPath([deniedDirectory, usableDirectory])

  const originalRealpath = fs.realpathSync
  const realpath = spyOn(fs, "realpathSync").mockImplementation(((candidate: fs.PathLike) =>
    String(candidate) === deniedCandidate ? "/mnt/c/Windows/codex.exe" : originalRealpath(candidate)) as typeof fs.realpathSync)
  try {
    expect(wslTransport.findExecutable("codex")).toBe(usableRealpath)
  } finally {
    realpath.mockRestore()
  }
})

test("Claude uses the verified stdin launch and emits assistant text once before its final result", async () => {
  const prompt = "private prompt fixture"
  const expectedArgs = [
    "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", "test-model:tag",
  ]
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("claude", fixtureSource({ expectedArgs, prompt, chunks: claudeOutput("answer"), marker, sourceRoot: sourceRoot() }))
  const observed: string[] = []
  const result = await createCliTransport(options("claude", { prompt, onText: text => observed.push(text) })).run()

  expect(result).toEqual({ status: "completed", text: "answer", quiescent: true })
  expect(observed.join("")).toBe("answer")
  const invocation = JSON.parse(readFileSync(marker, "utf8")) as { cwd: string; prompt: string }
  expect(invocation.prompt).toBe(prompt)
  expect(invocation.cwd).not.toBe(sourceRoot())
  expect(existsSync(invocation.cwd)).toBe(false)
})

test("Claude permits only the observed safe-mode builtin plugin names", async () => {
  const expectedArgs = [
    "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", "test-model:tag",
  ]
  for (const plugins of [
    ["cc-plugin-agents-md", { name: "cc-plugin-telemetry" }],
    [{ name: "cc-plugin-agents-md" }, "cc-plugin-telemetry"],
    // Claude CLI 2.1.301 init shape.
    [{ name: "cc-plugin-agents-md" }, { name: "cc-plugin-telemetry" }, { name: "cc-plugin-plugin-authoring" }],
  ]) {
    const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
    testDirectories.push(resolve(marker, ".."))
    installFakeCli("claude", fixtureSource({
      expectedArgs,
      prompt: "fixture prompt",
      chunks: claudeOutput("builtin plugins allowed", plugins),
      marker,
      sourceRoot: sourceRoot(),
    }))

    const result = await createCliTransport(options("claude")).run()
    expect(result).toEqual({ status: "completed", text: "builtin plugins allowed", quiescent: true })
  }
})

test("Claude accepts ordered rate-limit metadata without treating it as text, failure, or success", async () => {
  const expectedArgs = [
    "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", "test-model:tag",
  ]
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  const info = {
    status: "allowed",
    resetsAt: 1791659400,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.1 } },
  }
  const event = {
    type: "rate_limit_event",
    rate_limit_info: info,
    uuid: "rate-limit-fixture",
    session_id: "claude-session-fixture",
  }
  installFakeCli("claude", fixtureSource({
    expectedArgs,
    prompt: "fixture prompt",
    chunks: claudeRateLimitOutput(event),
    marker,
    sourceRoot: sourceRoot(),
  }))
  const observed: string[] = []
  const result = await createCliTransport(options("claude", { onText: text => observed.push(text) })).run()

  expect(result).toEqual({ status: "completed", text: "READY", quiescent: true })
  expect(observed.join("")).toBe("READY")
})

test("Claude ignores bound thinking-token telemetry and still requires the successful result", async () => {
  const result = await runClaudeFixture(claudeThinkingTokensOutput(thinkingTokensEvent()))

  expect(result).toEqual({ status: "completed", text: "READY", quiescent: true })
})

const invalidThinkingTokenEvents: Array<{
  name: string
  event: Record<string, unknown>
  placement?: "after-init" | "before-init" | "after-terminal"
}> = [
  { name: "missing estimated_tokens", event: thinkingTokensEvent({ estimated_tokens: undefined }) },
  { name: "missing estimated_tokens_delta", event: thinkingTokensEvent({ estimated_tokens_delta: undefined }) },
  { name: "null estimated_tokens", event: thinkingTokensEvent({ estimated_tokens: null }) },
  { name: "null estimated_tokens_delta", event: thinkingTokensEvent({ estimated_tokens_delta: null }) },
  { name: "string estimated_tokens", event: thinkingTokensEvent({ estimated_tokens: "50" }) },
  { name: "string estimated_tokens_delta", event: thinkingTokensEvent({ estimated_tokens_delta: "50" }) },
  { name: "negative estimated_tokens", event: thinkingTokensEvent({ estimated_tokens: -1 }) },
  { name: "negative estimated_tokens_delta", event: thinkingTokensEvent({ estimated_tokens_delta: -1 }) },
  { name: "fractional estimated_tokens", event: thinkingTokensEvent({ estimated_tokens: 0.5 }) },
  { name: "fractional estimated_tokens_delta", event: thinkingTokensEvent({ estimated_tokens_delta: 0.5 }) },
  { name: "unsafe estimated_tokens", event: thinkingTokensEvent({ estimated_tokens: Number.MAX_SAFE_INTEGER + 1 }) },
  { name: "unsafe estimated_tokens_delta", event: thinkingTokensEvent({ estimated_tokens_delta: Number.MAX_SAFE_INTEGER + 1 }) },
  { name: "mismatched session", event: thinkingTokensEvent({ session_id: "other-session" }) },
  { name: "missing session", event: thinkingTokensEvent({ session_id: undefined }) },
  { name: "unknown subtype", event: thinkingTokensEvent({ subtype: "future_system_event" }) },
  { name: "before initialization", event: thinkingTokensEvent(), placement: "before-init" },
  { name: "after terminal result", event: thinkingTokensEvent(), placement: "after-terminal" },
]

test.each(invalidThinkingTokenEvents.map(({ name, event, placement }) => [name, event, placement] as const))(
  "Claude refuses thinking-token metadata with %s despite later success",
  async (_name, event, placement) => {
    const result = await runClaudeFixture(claudeThinkingTokensOutput(event, placement))

    expect(result.status).not.toBe("completed")
    expect(result.quiescent).toBe(true)
    expect(result.error).toBeDefined()
  },
)

test("Claude refuses unrecognized plugins and maps only the exact native login failure", async () => {
  const expectedArgs = [
    "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", "test-model:tag",
  ]
  const prompt = "fixture prompt"
  const pluginMarker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(pluginMarker, ".."))
  installFakeCli("claude", fixtureSource({
    expectedArgs,
    prompt,
    chunks: claudeOutput("unreachable", [{ name: "unapproved-plugin" }]),
    marker: pluginMarker,
    sourceRoot: sourceRoot(),
  }))
  const pluginResult = await createCliTransport(options("claude", { prompt })).run()
  expect(pluginResult.status).toBe("failed")
  expect(pluginResult.error).toBe("native tool activity refused")

  const loginMarker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(loginMarker, ".."))
  const loginOutput = [
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-fixture", tools: [], plugins: ["cc-plugin-agents-md", "cc-plugin-telemetry"], mcp_servers: [] })}\n`,
    `${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: "claude-session-fixture" })}\n`,
  ]
  installFakeCli("claude", fixtureSource({ expectedArgs, prompt, chunks: loginOutput, marker: loginMarker, sourceRoot: sourceRoot() }))
  const loginResult = await createCliTransport(options("claude", { prompt })).run()
  expect(loginResult.status).toBe("failed")
  expect(loginResult.error).toBe("Claude CLI login required; run claude auth login")
  expect(loginResult.text).toBe("")

  const otherFailureMarker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(otherFailureMarker, ".."))
  const otherFailure = "Not logged in · SECRET native diagnostic"
  const otherFailureOutput = [
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-fixture", tools: [], plugins: [], mcp_servers: [] })}\n`,
    `${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: otherFailure, session_id: "claude-session-fixture" })}\n`,
  ]
  installFakeCli("claude", fixtureSource({ expectedArgs, prompt, chunks: otherFailureOutput, marker: otherFailureMarker, sourceRoot: sourceRoot() }))
  const otherFailureResult = await createCliTransport(options("claude", { prompt })).run()
  expect(otherFailureResult.status).toBe("failed")
  expect(otherFailureResult.error).toBe("native CLI reported failure")
  expect(otherFailureResult.error).not.toContain("SECRET")
})

test.each([
  ["missing content block", { type: "content_block_start", index: 0 }],
  ["null content block", { type: "content_block_start", index: 0, content_block: null }],
  ["array content block", { type: "content_block_start", index: 0, content_block: [] }],
  ["unknown content block type", { type: "content_block_start", index: 0, content_block: { type: "future_block" } }],
  ["missing content delta", { type: "content_block_delta", index: 0 }],
  ["null content delta", { type: "content_block_delta", index: 0, delta: null }],
  ["array content delta", { type: "content_block_delta", index: 0, delta: [] }],
  ["unknown content delta type", { type: "content_block_delta", index: 0, delta: { type: "future_delta" } }],
  ["missing message delta", { type: "message_delta" }],
  ["null message delta", { type: "message_delta", delta: null }],
  ["array message delta", { type: "message_delta", delta: [] }],
  ["unknown message stop reason", { type: "message_delta", delta: { stop_reason: "future_reason" } }],
  ["rate limit without own info", { type: "rate_limit_event", session_id: "claude-session-fixture" }],
  ["rate limit with null info", { type: "rate_limit_event", rate_limit_info: null, session_id: "claude-session-fixture" }],
  ["rate limit with array info", { type: "rate_limit_event", rate_limit_info: [], session_id: "claude-session-fixture" }],
  ["rate limit without own status", { type: "rate_limit_event", rate_limit_info: {}, session_id: "claude-session-fixture" }],
  ["rate limit with unknown status", { type: "rate_limit_event", rate_limit_info: { status: "future_status" }, session_id: "claude-session-fixture" }],
  ["rate limit from another session", { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: "other-session" }],
  ["unknown event type", { type: "future_event" }],
] as const)("Claude cannot complete after %s, even when a success result follows", async (_name, event) => {
  const expectedArgs = [
    "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", "test-model:tag",
  ]
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  const session = "claude-session-fixture"
  const chunks = [
    `${JSON.stringify({ type: "system", subtype: "init", session_id: session, tools: [], plugins: [], mcp_servers: [] })}\n`,
    `${JSON.stringify({ type: "stream_event", event, session_id: session })}\n`,
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, permission_denials: [], result: "must not complete", session_id: session })}\n`,
  ]
  installFakeCli("claude", fixtureSource({ expectedArgs, prompt: "fixture prompt", chunks, marker, sourceRoot: sourceRoot() }))

  const result = await createCliTransport(options("claude")).run()
  expect(result.status).not.toBe("completed")
  expect(result.quiescent).toBe(true)
  expect(result.error).toBeDefined()
})

test.each(["0.159.3", "0.163.0"])("Codex %s uses the owned restricted-read profile and requires completed native turn", async version => {
  setProcessPlatform("darwin")
  const expectedArgs = codexExpectedArgs()
  const prompt = "codex stdin fixture"
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("codex", fixtureSource({
    expectedArgs,
    prompt,
    chunks: codexOutput({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "codex answer" } }),
    marker,
    sourceRoot: sourceRoot(),
    version: `codex-cli ${version}`,
    invocationMarker: join(resolve(marker, ".."), "codex-invocations.jsonl"),
    profileCatalog: { name: `codex-${createCodexProfile(CODEX_MODEL).version}-catalog.json`, contents: createCodexProfile(CODEX_MODEL).catalogJson },
  }))
  const observed: string[] = []
  const result = await createCliTransport(options("codex", { prompt, onText: text => observed.push(text) })).run()

  expect(result).toEqual({ status: "completed", text: "codex answer", quiescent: true })
  expect(observed.join("")).toBe("codex answer")
  const invocation = JSON.parse(readFileSync(marker, "utf8")) as { cwd: string; profileRoot: string; prompt: string; argv: string[] }
  expect(invocation.prompt).toBe(prompt)
  expect(existsSync(invocation.cwd)).toBe(false)
  expect(existsSync(invocation.profileRoot)).toBe(false)

  const forbiddenOptions = new Set([
    "--sandbox", "-s", "-a", "--ask-for-approval", "--full-auto", "--dangerously-bypass-approvals-and-sandbox",
  ])
  expect(invocation.argv.some(argument => forbiddenOptions.has(argument))).toBe(false)
  const codexOverrides = invocation.argv.flatMap((argument, index) => argument === "-c" ? [invocation.argv[index + 1] ?? ""] : [])
  expect(codexOverrides.some(value => /^(sandbox_mode|sandbox_permissions|approval_policy)=/.test(value))).toBe(false)
  const permissionProfileIndex = invocation.argv.indexOf('default_permissions="otter_text_only"')
  const catalogIndex = invocation.argv.findIndex(argument => argument.startsWith("model_catalog_json="))
  expect(permissionProfileIndex).toBeGreaterThanOrEqual(0)
  expect(catalogIndex).toBeGreaterThan(permissionProfileIndex)
})

test("Codex Linux preflight verifies the pinned profile and inference rechecks the version", async () => {
  setProcessPlatform("linux")
  const profile = createCodexProfile(CODEX_MODEL)
  const prompt = "Linux Codex fixture"
  const directory = mkdtempSync(join(tmpdir(), "cli-transport-marker-"))
  testDirectories.push(directory)
  const marker = join(directory, "inference.json")
  const invocationMarker = join(directory, "codex-invocations.jsonl")
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt,
    chunks: codexOutput({ type: "item.completed", item: { type: "agent_message", text: "Linux answer" } }),
    marker,
    sourceRoot: sourceRoot(),
    version: "codex-cli 0.159.3",
    invocationMarker,
    profileCatalog: { name: `codex-${profile.version}-catalog.json`, contents: profile.catalogJson },
  }))
  const handle = createCliTransport(options("codex", { prompt }))

  expect(await handle.preflight?.()).toEqual({ compatible: true, nativePolicyHash: profile.catalogHash })
  expect(existsSync(marker)).toBe(false)
  expect(await handle.run()).toEqual({ status: "completed", text: "Linux answer", quiescent: true })
  const invocations = readFileSync(invocationMarker, "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as { argv: string[] })
  expect(invocations).toHaveLength(3)
  expect(invocations.slice(0, 2).map(invocation => invocation.argv)).toEqual([["--version"], ["--version"]])
  expect(invocations[2]?.argv[0]).toBe("exec")
})

test("Codex refuses unsupported Windows platform before any executable spawn", async () => {
  setProcessPlatform("win32")
  const directory = mkdtempSync(join(tmpdir(), "cli-transport-marker-"))
  testDirectories.push(directory)
  const marker = join(directory, "invocation.json")
  const invocationMarker = join(directory, "codex-invocations.jsonl")
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt: "must not reach inference",
    chunks: ["must not be emitted"],
    marker,
    sourceRoot: sourceRoot(),
    version: "codex-cli 0.159.3",
    invocationMarker,
  }))
  const handle = createCliTransport(options("codex", { prompt: "must not reach inference" }))

  expect(await handle.preflight?.()).toEqual({ compatible: false })
  expect(await handle.run()).toEqual({
    status: "failed",
    text: "",
    quiescent: true,
    error: "Codex native profile verification failed",
  })
  expect(existsSync(invocationMarker)).toBe(false)
  expect(existsSync(marker)).toBe(false)
})

test.each(["preflight-first", "run-first"] as const)("Codex probe cancellation in %s order prevents inference and cleans owned scratch", async startOrder => {
  setProcessPlatform("darwin")
  const directory = mkdtempSync(join(tmpdir(), "cli-transport-marker-"))
  testDirectories.push(directory)
  const marker = join(directory, "invocation.json")
  const versionMarker = join(directory, "probe-scratch.json")
  const invocationMarker = join(directory, "codex-invocations.jsonl")
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt: "must not reach inference",
    chunks: ["must not be emitted"],
    marker,
    sourceRoot: sourceRoot(),
    version: "codex-cli 0.159.3",
    versionMarker,
    versionLinger: true,
    invocationMarker,
  }))
  const handle = createCliTransport(options("codex", { prompt: "must not reach inference" }))
  const started = startOrder === "preflight-first" ? handle.preflight!() : handle.run()
  await waitForPath(versionMarker)
  const cancellation = await handle.requestCancel("cancel version probe", Date.now() + 3000)
  expect(cancellation.requested).toBe(true)
  const startedResult = await started
  if (startOrder === "preflight-first") expect(startedResult).toEqual({ compatible: false })
  else expect(startedResult).toMatchObject({ status: "cancelled", text: "", quiescent: true })
  const finalResult = startOrder === "preflight-first" ? await handle.run() : startedResult
  expect(finalResult).toMatchObject({ status: "cancelled", text: "", quiescent: true })
  expect(await handle.reconcile()).toMatchObject({ outcome: "terminal", quiescent: true })
  expect(existsSync(marker)).toBe(false)
  const invocations = readFileSync(invocationMarker, "utf8").trim().split("\n").map(line => JSON.parse(line) as { argv: string[]; cwd: string })
  expect(invocations).toHaveLength(1)
  expect(invocations[0]?.argv).toEqual(["--version"])
  const probe = JSON.parse(readFileSync(versionMarker, "utf8")) as { cwd: string }
  expect(existsSync(probe.cwd)).toBe(false)
})

test("Codex preflight checks the pinned version without inference and run rechecks before launch", async () => {
  setProcessPlatform("darwin")
  const profile = createCodexProfile(CODEX_MODEL)
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt: "preflight fixture",
    chunks: codexOutput({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    marker,
    sourceRoot: sourceRoot(),
    version: "codex-cli 0.159.3",
  }))
  const handle = createCliTransport(options("codex", { prompt: "preflight fixture" }))
  expect(await handle.preflight?.()).toEqual({ compatible: true, nativePolicyHash: profile.catalogHash })
  expect(existsSync(marker)).toBe(false)
  expect(await handle.run()).toEqual({ status: "completed", text: "answer", quiescent: true })
  expect(existsSync(marker)).toBe(true)
})

test.each(["0.159.2", "0.163.1", "0.164.0", "0.163.0-dev"])("Codex refuses unexpected CLI version %s before launching inference", async version => {
  setProcessPlatform("darwin")
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt: "must not reach inference",
    chunks: ["must not be emitted"],
    marker,
    sourceRoot: sourceRoot(),
    version: `codex-cli ${version}`,
  }))
  expect(() => createCliTransport(options("codex", { model: "unknown-codex-slug" }))).toThrow("unsupported Codex model profile")
  const result = await createCliTransport(options("codex", { prompt: "must not reach inference" })).run()
  expect(result).toMatchObject({ status: "failed", quiescent: true, error: "Codex native profile verification failed" })
  expect(existsSync(marker)).toBe(false)
})

test("Codex cleanup retries only remaining owned entries after a partial removal", async () => {
  setProcessPlatform("darwin")
  const profile = createCodexProfile(CODEX_MODEL)
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt: "partial cleanup fixture",
    chunks: codexOutput({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    marker,
    sourceRoot: sourceRoot(),
    version: "codex-cli 0.159.3",
  }))
  const originalRmdir = fs.rmdirSync
  let refuseRemoval = true
  const removal = spyOn(fs, "rmdirSync").mockImplementation((path) => {
    if (refuseRemoval && existsSync(marker)) {
      const invocation = JSON.parse(readFileSync(marker, "utf8"))
      if (path === invocation.cwd) throw Object.assign(new Error("owned fixture busy"), { code: "EBUSY" })
    }
    return originalRmdir(path)
  })
  try {
    const handle = createCliTransport(options("codex", { prompt: "partial cleanup fixture" }))
    expect(await handle.run()).toMatchObject({ status: "failed", quiescent: true, error: "scratch cleanup failed" })
    const invocation = JSON.parse(readFileSync(marker, "utf8"))
    testDirectories.push(invocation.profileRoot)
    expect(existsSync(join(invocation.profileRoot, `codex-${profile.version}-catalog.json`))).toBe(false)
    expect(existsSync(invocation.cwd)).toBe(true)
    refuseRemoval = false
    const reconciliation = await handle.reconcile()
    expect(reconciliation.quiescent).toBe(true)
    expect(reconciliation.evidence).not.toContain("scratch cleanup failed")
    expect(existsSync(invocation.profileRoot)).toBe(false)
  } finally {
    removal.mockRestore()
  }
})

test("Codex cleanup preserves a replaced private catalog and reports bounded failure", async () => {
  setProcessPlatform("darwin")
  const profile = createCodexProfile(CODEX_MODEL)
  const catalogName = `codex-${profile.version}-catalog.json`
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt: "catalog replacement fixture",
    chunks: codexOutput({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    marker,
    sourceRoot: sourceRoot(),
    version: "codex-cli 0.159.3",
    profileCatalog: { name: catalogName, contents: profile.catalogJson },
    replaceCatalog: true,
  }))

  const handle = createCliTransport(options("codex", { prompt: "catalog replacement fixture" }))
  const result = await handle.run()
  const reconciliation = await handle.reconcile()
  const invocation = JSON.parse(readFileSync(marker, "utf8")) as {
    profileRoot: string
    catalogPath: string
    originalCatalogPath: string
  }
  testDirectories.push(invocation.profileRoot)

  expect(result).toMatchObject({ status: "failed", quiescent: true, text: "answer", error: "scratch cleanup failed" })
  expect(reconciliation).toMatchObject({ quiescent: true })
  expect(reconciliation.evidence).toContain("scratch cleanup failed")
  expect(readFileSync(invocation.catalogPath, "utf8")).toBe("preserve replacement catalog")
  expect(existsSync(invocation.originalCatalogPath)).toBe(true)
})

test("Ollama receives a plain model identifier and returns stdout, not stderr", async () => {
  const prompt = "local stdin fixture"
  const expectedArgs = ["run", "test-model:tag", "--think=false", "--nowordwrap"]
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs,
    prompt,
    chunks: ['{"answer":"local"}\n'],
    marker,
    sourceRoot: sourceRoot(),
  }).replace("const chunks =", 'process.stderr.write("spinner must not be response\\n")\nconst chunks ='))
  const observed: string[] = []
  const result = await createCliTransport(options("local", { prompt, onText: text => observed.push(text) })).run()

  expect(result).toEqual({ status: "completed", text: '{"answer":"local"}\n', quiescent: true })
  expect(observed.join("")).toBe(result.text)
})

test.each([
  ["malformed JSON", ["not-json\n"], "invalid native CLI output"],
  ["native failure", codexOutput({ type: "item.completed", item: { type: "agent_message", text: "partial" } }, { type: "turn.failed", error: { message: "SECRET diagnostic" } }), "native CLI reported failure"],
  ["tool activity", codexOutput({ type: "item.completed", item: { type: "file_change", changes: [{ path: "source.ts", kind: "update" }] } }), "native tool activity refused"],
])("Codex rejects %s without leaking native diagnostics", async (_kind, chunks, expectedError) => {
  setProcessPlatform("darwin")
  const prompt = "codex failure fixture"
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("codex", fixtureSource({
    expectedArgs: codexExpectedArgs(),
    prompt,
    chunks: chunks as string[],
    marker,
    sourceRoot: sourceRoot(),
    version: "codex-cli 0.159.3",
  }))

  const result = await createCliTransport(options("codex", { prompt })).run()
  expect(result.status).toBe("failed")
  expect(result.error).toBe(expectedError)
  expect(result.error).not.toContain("SECRET")
})

test("output byte cap cancels reactively and returns only bounded text", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs: ["run", "test-model:tag", "--think=false", "--nowordwrap"],
    prompt: "fixture prompt",
    chunks: ["0123456789"],
    marker,
    sourceRoot: sourceRoot(),
    linger: true,
  }))
  const observed: string[] = []
  const result = await createCliTransport(options("local", { maxOutputBytes: 4, onText: text => observed.push(text) })).run()

  expect(result.status).toBe("incomplete")
  expect(result.error).toBe("output byte limit reached")
  expect(result.text).toBe("0123")
  expect(observed.join("")).toBe("0123")
  expect(result.quiescent).toBe(true)
})

test("cleanup preserves a replaced scratch directory and reports bounded failure", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs: ["run", "test-model:tag", "--think=false", "--nowordwrap"],
    prompt: "fixture prompt",
    chunks: ["response"],
    marker,
    sourceRoot: sourceRoot(),
    replaceScratch: true,
  }))

  const result = await createCliTransport(options("local")).run()
  const replacement = JSON.parse(readFileSync(marker, "utf8")) as { cwd: string; originalPath: string }
  testDirectories.push(replacement.cwd, replacement.originalPath)

  expect(result).toEqual({ status: "failed", text: "response", quiescent: true, error: "scratch cleanup failed" })
  expect(readFileSync(join(replacement.cwd, "sentinel"), "utf8")).toBe("preserve replacement")
  expect(existsSync(replacement.originalPath)).toBe(true)
})

test("late quiescence reconciliation removes the retained owned scratch directory", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs: ["run", "test-model:tag", "--think=false", "--nowordwrap"],
    prompt: "fixture prompt",
    chunks: ["response"],
    marker,
    sourceRoot: sourceRoot(),
    descendantDelayMs: 1700,
  }))
  const handle = createCliTransport(options("local"))
  const result = await handle.run()
  const invocation = JSON.parse(readFileSync(marker, "utf8")) as { cwd: string }
  testDirectories.push(invocation.cwd)

  expect(result.status).toBe("unresolved")
  expect(result.quiescent).toBe(false)
  expect(existsSync(invocation.cwd)).toBe(true)

  const deadline = Date.now() + 3000
  let reconciliation = await handle.reconcile()
  while ((!reconciliation.quiescent || reconciliation.outcome !== "terminal") && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
    reconciliation = await handle.reconcile()
  }

  expect(reconciliation.outcome).toBe("terminal")
  expect(reconciliation.quiescent).toBe(true)
  expect(existsSync(invocation.cwd)).toBe(false)
})

test("late scratch cleanup preserves an identity-mismatched replacement", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs: ["run", "test-model:tag", "--think=false", "--nowordwrap"],
    prompt: "fixture prompt",
    chunks: ["response"],
    marker,
    sourceRoot: sourceRoot(),
    replaceScratch: true,
    descendantDelayMs: 1700,
  }))
  const handle = createCliTransport(options("local"))
  const result = await handle.run()
  const replacement = JSON.parse(readFileSync(marker, "utf8")) as { cwd: string; originalPath: string }
  testDirectories.push(replacement.cwd, replacement.originalPath)

  expect(result.status).toBe("unresolved")
  expect(result.quiescent).toBe(false)
  expect(existsSync(replacement.cwd)).toBe(true)

  const deadline = Date.now() + 3000
  let reconciliation = await handle.reconcile()
  while ((!reconciliation.quiescent || reconciliation.outcome !== "terminal") && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
    reconciliation = await handle.reconcile()
  }

  expect(reconciliation.outcome).toBe("terminal")
  expect(reconciliation.quiescent).toBe(true)
  expect(reconciliation.evidence).toContain("scratch cleanup failed")
  expect(readFileSync(join(replacement.cwd, "sentinel"), "utf8")).toBe("preserve replacement")
  expect(existsSync(replacement.originalPath)).toBe(true)
})

test("pre-run cancellation prevents launch and transport handles cannot replay", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs: ["run", "test-model:tag", "--think=false", "--nowordwrap"],
    prompt: "fixture prompt",
    chunks: ["must not run"],
    marker,
    sourceRoot: sourceRoot(),
  }))
  const handle = createCliTransport(options("local"))
  const cancel = await handle.requestCancel("test", Date.now() + 1000)

  expect(cancel).toMatchObject({ requested: true, acknowledged: true, terminal: true, quiescent: true })
  expect(await handle.run()).toEqual({ status: "cancelled", text: "", quiescent: true })
  expect(existsSync(marker)).toBe(false)
  await expect(handle.run()).rejects.toThrow("one-shot")
})

test("running cancellation waits for owned group termination and quiescence", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs: ["run", "test-model:tag", "--think=false", "--nowordwrap"],
    prompt: "fixture prompt",
    chunks: ["running"],
    marker,
    sourceRoot: sourceRoot(),
    linger: true,
  }))
  const handle = createCliTransport(options("local"))
  const run = handle.run()
  await new Promise(resolveWait => setTimeout(resolveWait, 30))
  const cancel = await handle.requestCancel("test", Date.now() + 1000)
  const result = await run

  expect(cancel.requested).toBe(true)
  expect(result.status).toBe("cancelled")
  expect(result.quiescent).toBe(true)
})

test("model option injection and callback failures are bounded", async () => {
  expect(() => createCliTransport(options("codex", { model: "--dangerous" }))).toThrow("invalid CLI transport options")

  const marker = join(mkdtempSync(join(tmpdir(), "cli-transport-marker-")), "invocation.json")
  testDirectories.push(resolve(marker, ".."))
  installFakeCli("local", fixtureSource({
    expectedArgs: ["run", "test-model:tag", "--think=false", "--nowordwrap"],
    prompt: "fixture prompt",
    chunks: ["response"],
    marker,
    sourceRoot: sourceRoot(),
  }))
  const result = await createCliTransport(options("local", {
    onText() { throw new Error("SECRET callback detail") },
  })).run()

  expect(result.status).toBe("failed")
  expect(result.error).toBe("output callback failed")
  expect(result.error).not.toContain("SECRET")
})


test("local retention is snapshotted into Ollama argv and omitted by default", async () => {
  installFakeCli("local", `process.stdout.write(JSON.stringify(process.argv.slice(2)))`)
  for (const keepAlive of [undefined, "0", "-1", "5m", "24h"]) {
    const input = options("local", { localKeepAlive: keepAlive })
    const handle = createCliTransport(input)
    input.localKeepAlive = "1h"
    const result = await handle.run()
    expect(result.status).toBe("completed")
    expect(JSON.parse(result.text)).toEqual(["run", "test-model:tag", "--think=false", "--nowordwrap", ...(keepAlive === undefined ? [] : ["--keepalive", keepAlive === "-1" ? "-1m" : keepAlive])])
  }
})

test("invalid local retention is rejected before executable lookup", () => {
  for (const value of [null, 5, "25h", "-2", "5m --verbose", "1.5h"]) {
    expect(() => createCliTransport(options("local", { localKeepAlive: value as never }))).toThrow("invalid CLI transport options")
  }
})

test("cloud transport never forwards local retention", async () => {
  const directory = installFakeCli("claude", `
    require("node:fs").writeFileSync(require("node:path").join(import.meta.dir, "argv.json"), JSON.stringify(process.argv.slice(2)))
    process.stdout.write(${JSON.stringify(claudeOutput("done").join(""))})
  `)
  expect((await createCliTransport(options("claude", { localKeepAlive: "5m" })).run()).status).toBe("completed")
  expect(JSON.parse(readFileSync(join(directory, "argv.json"), "utf8"))).not.toContain("--keepalive")
})
