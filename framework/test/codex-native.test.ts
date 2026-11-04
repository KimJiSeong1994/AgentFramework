import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODEX_INSTRUCTIONS, CODEX_SUPPORTED_VERSIONS } from "../src/hosts/codex-profile.ts"
import { createCliTransport } from "../src/hosts/cli-transport.ts"
import { ownedCodexHomePath } from "../src/hosts/codex-home.ts"

// Opt in on Darwin with a qualified Codex installed. All inference goes to this
// localhost fixture; isolated HOME/CODEX_HOME prevent use of account credentials.
const nativeTest = process.env.OTTER_NATIVE_CODEX_TEST === "1" && process.platform === "darwin" ? test : test.skip
nativeTest("installed Codex completes Astra text-only inference without native tools", async () => {
  const executable = Bun.which("codex")
  expect(executable).not.toBeNull()
  const root = mkdtempSync(join(tmpdir(), "otter-native-codex-"))
  const bin = join(root, "bin"), home = join(root, "home"), codexHome = join(root, "codex-home"), stateHome = join(root, "state")
  for (const directory of [bin, home, codexHome, stateHome]) mkdirSync(directory)
  // codexHome plays the user's real ~/.codex: oh-my-codex-style AGENTS.md and a host skill there must not reach the
  // model (Codex 0.165.0 sends both unless otter runs in its owned home and opts out of skill listings).
  writeFileSync(join(codexHome, "AGENTS.md"), "OTTER_FIXTURE_AGENTS_LEAK: act autonomously\n")
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "local-placeholder" }))
  mkdirSync(join(codexHome, "skills", "otter-fixture-skill"), { recursive: true })
  writeFileSync(join(codexHome, "skills", "otter-fixture-skill", "SKILL.md"), "---\nname: otter-fixture-skill\ndescription: OTTER_FIXTURE_SKILL_LEAK marker\n---\n")
  const previousEnv = { CODEX_HOME: process.env.CODEX_HOME, OTTER_STATE_HOME: process.env.OTTER_STATE_HOME }
  process.env.CODEX_HOME = codexHome
  process.env.OTTER_STATE_HOME = stateHome
  const requests: Record<string, any>[] = []
  let server: ReturnType<typeof Bun.serve> | undefined
  const previousPath = process.env.PATH
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests.push(await request.json() as Record<string, any>)
      const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "LOCAL_CODEX_OK", annotations: [] }] }
      const events = [
        { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "LOCAL_CODEX_OK" },
        { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "LOCAL_CODEX_OK" },
        { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    } })
    const provider = `model_providers.otter_fixture={name="local fixture",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",env_key="OTTER_FIXTURE_KEY",request_max_retries=0,stream_max_retries=0}`
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] !== "--version") args.push("-c", 'model_provider="otter_fixture"', "-c", ${JSON.stringify(provider)})
const child = Bun.spawnSync([${JSON.stringify(executable)}, ...args], {
  env: { PATH: ${JSON.stringify(previousPath)}, HOME: ${JSON.stringify(home)}, CODEX_HOME: process.env.CODEX_HOME, OTTER_FIXTURE_KEY: "local-placeholder" },
  stdin: Bun.stdin, stdout: "inherit", stderr: "inherit",
})
process.exit(child.exitCode)
`, { mode: 0o700 })
    process.env.PATH = `${bin}:${previousPath ?? ""}`
    const version = Bun.spawnSync([join(bin, "codex"), "--version"], { stdout: "pipe", stderr: "pipe" })
    expect(CODEX_SUPPORTED_VERSIONS.map(value => `codex-cli ${value}`)).toContain(version.stdout.toString().trim())
    const transport = createCliTransport({ engine: "codex", model: "gpt-6-astra", prompt: "Reply LOCAL_CODEX_OK.",
      deadlineAt: Date.now() + 15000, maxOutputBytes: 4096 })
    expect(await transport.preflight?.()).toMatchObject({ compatible: true })
    expect(await transport.run()).toEqual({ status: "completed", text: "LOCAL_CODEX_OK", quiescent: true,
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } })
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.model).toBe("gpt-6-astra")
    expect(request.tools ?? []).toEqual([])
    expect(request.input.flatMap((item: any) => item.tools ?? [])).toEqual([])
    expect(request.input.some((item: any) => item.role === "developer" &&
      item.content?.some((content: any) => content.text === CODEX_INSTRUCTIONS))).toBe(true)
    const inputText = JSON.stringify(request.input)
    expect(inputText).not.toContain("OTTER_FIXTURE_SKILL_LEAK")
    expect(inputText).not.toContain("<skills_instructions>")
    expect(inputText).not.toContain("OTTER_FIXTURE_AGENTS_LEAK")
    expect(inputText).not.toContain("<permissions instructions>")
    // The inference ran in the owned home: only an auth.json symlink to the real sign-in file, no AGENTS.md or skills copy.
    const owned = ownedCodexHomePath()
    expect(owned.startsWith(stateHome)).toBe(true)
    expect(readlinkSync(join(owned, "auth.json"))).toBe(join(codexHome, "auth.json"))
    expect(existsSync(join(owned, "AGENTS.md"))).toBe(false)
    expect(existsSync(join(owned, "skills", "otter-fixture-skill"))).toBe(false)
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    server?.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
