#!/usr/bin/env bun
// Live smoke for model-loaded skills: real CLI host + real engine in a scratch git worktree with a fixed two-skill
// catalog. Each argument after <engine> <model> is one conversation turn; prints one JSON line per turn with the skills
// the model loaded. Usage: bun scripts/otter-skill-tool-smoke.ts local gemma4-26b-mtp:latest "turn 1" "turn 2"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const FW = new URL("../framework/src", import.meta.url).pathname
const { createCliRuntime } = await import(`${FW}/hosts/cli-runtime.ts`)
const { createPlanConversation } = await import(`${FW}/hosts/plan-conversation.ts`)
const { attachAdmission } = await import(`${FW}/sessions/admission.ts`)

const [engine, model] = [process.argv[2], process.argv[3]]
if (!engine || !model || process.argv.length < 5) { console.error("usage: otter-skill-tool-smoke.ts <local|codex|claude> <model> <turn>..."); process.exit(2) }
const wt = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-skill-smoke-")))
process.env.OTTER_STATE_HOME = join(wt, ".state-home")
const git = (...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: wt, stdio: "pipe" })
git("init", "-q"); git("config", "user.email", "s@x"); git("config", "user.name", "s")
writeFileSync(join(wt, "README.md"), "# demo\n")
git("add", "-A"); git("commit", "-q", "-m", "init")
const { createCliTransport } = await import(`${FW}/hosts/cli-transport.ts`)
const raws: string[] = []
const runtime = createCliRuntime({ worktree: wt, engine, model, createTransport: (o: never) => {
  const t = createCliTransport(o)
  const run = t.run.bind(t)
  ;(t as { run: typeof run }).run = async () => { const r = await run(); raws.push(String((r as { text?: string }).text ?? "")); return r }
  return t
} })
const sessionID = "smoke-session"
attachAdmission(runtime, sessionID, { engine, model })
const loads: string[] = []
const skillTool = {
  catalog: [
    { name: "release-notes", description: "Write release notes in the team's required format (sections, emoji rules, version header). Use whenever the user asks for release notes or a changelog entry." },
    { name: "sql-style", description: "Team SQL style guide for writing or reviewing SQL queries." },
  ],
  async load(name: string) {
    loads.push(name)
    return { ok: true as const, text: name === "release-notes"
      ? "# release-notes\nAlways start with the exact line `RELEASE-NOTES-v2` then a heading `## What changed` with bullet points. End with the exact line `-- otter`."
      : "# sql-style\nUppercase keywords." }
  },
}
const prepare = runtime.host.prepare.bind(runtime.host)
const outcomes: unknown[] = []
;(runtime.host as { prepare: typeof prepare }).prepare = async (request: never) => {
  const handle = await prepare(request)
  const run = handle.run.bind(handle)
  ;(handle as { run: typeof run }).run = async () => { const outcome = await run(); outcomes.push(outcome); return outcome }
  return handle
}
const conversation = createPlanConversation(runtime, sessionID)
const prompts = process.argv.slice(4)
for (const text of prompts) {
  const before = loads.length
  const started = Date.now()
  try {
    const turn = await conversation.turn(text, AbortSignal.timeout(600_000), undefined, skillTool)
    console.log(JSON.stringify({ engine, model, text, loaded: loads.slice(before), ms: Date.now() - started, reply: turn.text.slice(0, 400) }))
  } catch (error) {
    console.log(JSON.stringify({ engine, model, text, loaded: loads.slice(before), ms: Date.now() - started, error: String((error as Error).message).slice(0, 300), host: JSON.stringify(outcomes.at(-1)).slice(0, 300), raw: raws.at(-1)?.slice(0, 600) }))
  }
}
process.exit(0)
