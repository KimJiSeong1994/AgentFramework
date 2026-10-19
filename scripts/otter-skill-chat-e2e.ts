#!/usr/bin/env bun
// Real `otter chat` end to end: launchInteractive with defaultDependencies; only the terminal is scripted (an intent
// offer is answered "Continue in chat"; any other prompt, e.g. skill consent, is refused and counted). Runs in a scratch
// git worktree with two committed project skills; user config and state are isolated.
// Usage: bun scripts/otter-skill-chat-e2e.ts <local|codex|claude> <model> "<line>"...
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const FW = new URL("../framework/src", import.meta.url).pathname
const [engine, model] = [process.argv[2], process.argv[3]]
if (!engine || !model || process.argv.length < 5) { console.error("usage: otter-skill-chat-e2e.ts <local|codex|claude> <model> <line>..."); process.exit(2) }
const lines = process.argv.slice(4)
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-e2e-")))
const wt = join(base, "repo"); mkdirSync(wt)
process.env.OTTER_STATE_HOME = join(base, "state"); process.env.XDG_STATE_HOME = join(base, "xdg-state")
process.env.XDG_CONFIG_HOME = join(base, "config")   // no user skill_trust: only committed project skills qualify
mkdirSync(join(base, "config", "otter"), { recursive: true })
const git = (...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: wt, stdio: "pipe" })
git("init", "-q"); git("config", "user.email", "e@x"); git("config", "user.name", "e")
writeFileSync(join(wt, "README.md"), "# demo\n")
for (const [name, desc, body] of [
  ["release-notes", "Write release notes in the team's required format. Use whenever the user asks for release notes, a changelog entry or a deployment document.", "Always start with the exact line `RELEASE-NOTES-v2`, then `## What changed` with bullet points, and end with the exact line `-- otter`."],
  ["sql-style", "Team SQL style guide for writing or reviewing SQL queries.", "Uppercase keywords; one clause per line."],
]) { mkdirSync(join(wt, ".agents", "skills", name), { recursive: true }); writeFileSync(join(wt, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`) }
git("add", "-A"); git("commit", "-q", "-m", "init")
const { launchInteractive } = await import(`${FW}/hosts/interactive.ts`)
const { defaultDependencies } = await import(`${FW}/hosts/interactive-session.ts`)
const out: string[] = []
const queue = [...lines, "/quit"]
const deps = defaultDependencies()
deps.cwd = wt
deps.terminal = {
  stdinIsTTY: true, stderrIsTTY: true,
  readLine: async () => queue.shift(),
  write: (t: string) => { out.push(t) },
  // An intent offer is answered "Continue in chat" (index 0); any other prompt (e.g. skill consent) is refused.
  choose: async (title: string, values: readonly string[]) => { out.push(`[CHOICE PROMPTED] ${title} :: ${values.join(" | ")}\n`); return values[0] === "Continue in chat" ? 0 : undefined },
  close() {},
} as never
const started = Date.now()
const exit = await launchInteractive({ worktree: wt, engine, model }, deps)
const text = out.join("")
const lines2 = text.split("\n").filter(l => /Skills used|Conversation:|RELEASE-NOTES|-- otter|CHOICE PROMPTED|error|refused|Automatic skills|candidates/i.test(l))
console.log(JSON.stringify({ engine, model, exit, ms: Date.now() - started, choicePrompts: (text.match(/CHOICE PROMPTED/g) ?? []).length }))
console.log(text.slice(0, 6000))
process.exit(0)
