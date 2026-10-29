// Chat execution (`chat.execute` ask/auto-edit): what the human sees before allowing a write, edit or command, which
// commands are refused outright, which saved "Always allow" rules apply, and how an approved command runs.
//
// Authority: only local human input, or a rule the human saved in the *user* config, allows an action. A project config
// cannot pre-approve anything (a cloned repository must not grant itself execution), and model text never decides.
import { readFileSync } from "node:fs"
import { applyEdits, modify } from "jsonc-parser"
import { parseJsonc, userConfigPath } from "../config.ts"
import { startShell } from "../orchestration/shell.ts"
import { rewriteUserConfig } from "./default-model.ts"
import { runTerminalShell } from "./operator-shell.ts"
import type { ChatAction } from "./types.ts"

/** Output returned to the model for a captured command (the verify runner's tail size). */
const COMMAND_OUTPUT_CHARS = 16_000
const MAX_ALLOW_RULES = 100

/**
 * Commands refused even when the human would allow them: privilege escalation, wiping the filesystem or home, raw disk
 * writes, force pushes, shutting the machine down and fork bombs. The human can still run them with `!<command>`.
 */
const REFUSED: readonly { pattern: RegExp; reason: string }[] = [
  // In command position: the start, or after ; & | ( (an argument such as `echo sudo` is not escalation).
  { pattern: /(^|[;&|(])\s*(sudo|su|doas|pkexec)(\s|$)/u, reason: "privilege escalation" },
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)[a-z-]*\s+(\/|~|\$HOME)(\s|\/?\*?\s*$|\/?$)/iu, reason: "deletes the filesystem or home root" },
  { pattern: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+[\w./-]+)/u, reason: "force push" },
  { pattern: /\b(mkfs(\.\w+)?|fdisk|diskutil\s+erase\w*)\b/u, reason: "disk formatting" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//u, reason: "raw disk write" },
  { pattern: /(^|[;&|(])\s*(shutdown|reboot|halt|poweroff)(\s|$)/u, reason: "shuts the machine down" },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/u, reason: "fork bomb" },
  { pattern: />\s*\/dev\/(sd|disk|nvme)/u, reason: "raw disk write" },
]

/** Why a command is refused outright, or undefined when the human may decide. */
export function refusedCommand(command: string): string | undefined {
  return REFUSED.find(rule => rule.pattern.test(command))?.reason
}

/**
 * The "Always allow" rule a command offers: its first two words (`bun test`, `git status`, `npm run`), or one word for a
 * bare command. Commands that chain, pipe, redirect or substitute offer no rule, so a rule never covers a different
 * command glued onto an allowed one.
 */
export function commandRule(command: string): string | undefined {
  const trimmed = command.trim()
  if (!trimmed || /[;&|<>`$(){}\\\n]/u.test(trimmed)) return undefined
  const words = trimmed.split(/\s+/u)
  if (!/^[A-Za-z0-9._/@+-]+$/u.test(words[0]!)) return undefined
  const second = words[1]
  return second && /^[A-Za-z0-9._:@+-]+$/u.test(second) && !second.startsWith("-") ? `${words[0]} ${second}` : words[0]
}

/**
 * Whether a saved rule covers this command. A rule is a word prefix (`bun test` covers `bun test foo.test.ts`; `make`
 * covers `make install`), and only for a command without chaining, pipes, redirection or substitution.
 */
export function allowedByRules(command: string, rules: readonly string[]): boolean {
  const rule = commandRule(command)
  if (!rule) return false
  const first = rule.split(" ")[0]!
  return rules.includes(rule) || rules.includes(first)
}

/** Saved rules from the user config only (`chat.allow`); a missing or broken file means no rules. */
export function readAllowRules(path = userConfigPath()): string[] {
  try {
    const parsed = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"))
    const chat = parsed && typeof parsed === "object" ? parsed.chat : undefined
    const allow = chat && typeof chat === "object" && !Array.isArray(chat) ? (chat as Record<string, unknown>).allow : undefined
    return Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === "string" && commandRule(rule) === rule).slice(0, MAX_ALLOW_RULES) : []
  } catch { return [] }
}

const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }

/** Save one rule to the user config; returns the path written. */
export function saveAllowRule(rule: string): string {
  if (commandRule(rule) !== rule) throw new TypeError("not a saveable command rule")
  return rewriteUserConfig(text => {
    const rules = readAllowRules()
    return rules.includes(rule) ? text : applyEdits(text, modify(text, ["chat", "allow"], [...rules, rule].slice(-MAX_ALLOW_RULES), formatting))
  })
}

/** Remove every saved rule; returns how many there were. */
export function clearAllowRules(): number {
  const count = readAllowRules().length
  if (count) rewriteUserConfig(text => applyEdits(text, modify(text, ["chat", "allow"], undefined, formatting)))
  return count
}

/** Worktree-relative paths an action writes (empty for commands). */
export function actionPaths(action: ChatAction): string[] {
  if (action.tool === "bash" || action.tool === "model_api") return []
  if (action.tool === "multiedit") return [...new Set(action.edits.map(edit => edit.path))]
  return [action.path]
}

/**
 * The directory a "this turn" grant covers: the deepest folder holding every path the action writes (`.` for the root).
 * Undefined for commands, which are never granted by folder.
 */
export function grantDirectory(action: ChatAction): string | undefined {
  const paths = actionPaths(action)
  if (!paths.length) return undefined
  const parts = paths.map(path => path.replace(/\\/gu, "/").replace(/^\.\//u, "").split("/").slice(0, -1))
  const shared: string[] = []
  for (let index = 0; parts.every(segments => index < segments.length && segments[index] === parts[0]![index]); index++) shared.push(parts[0]![index]!)
  return shared.length ? shared.join("/") : "."
}

/** Whether a granted folder covers every path this action writes. */
export function coveredByGrant(action: ChatAction, directories: ReadonlySet<string>): boolean {
  const paths = actionPaths(action)
  if (!paths.length || !directories.size) return false
  return paths.every(path => {
    const normalized = path.replace(/\\/gu, "/").replace(/^\.\//u, "")
    if (normalized.split("/").includes("..")) return false
    return [...directories].some(directory => directory === "." || normalized.startsWith(`${directory}/`))
  })
}

/** One-line title and a bounded preview the human reads before deciding. */
export function describeAction(action: ChatAction, maxLines = 40): { title: string; preview: string[] } {
  const clip = (lines: string[]) => lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more line(s)`] : lines
  if (action.tool === "model_api") {
    return {
      title: `Call model API: ${action.target} / ${action.model}`,
      preview: [`POST ${action.url} (${action.protocol})`,
        `Output limit ${action.maxOutputTokens} tokens; time limit ${action.timeoutSeconds}s. Remote calls may incur charges.`,
        ...(action.apiKeyEnv ? [`Credential: environment variable ${action.apiKeyEnv} (value hidden).`] : []),
        "Exact prompt sent:", ...action.prompt.split("\n")],
    }
  }
  if (action.tool === "bash") {
    return {
      title: `Run${action.interactive ? " (interactive)" : ""}: ${action.command.length > 200 ? `${action.command.slice(0, 199)}…` : action.command}`,
      preview: [`$ ${action.command}`, action.interactive ? "Gets your terminal; output is not returned to otter." : `Time limit ${Math.round(action.timeoutMs / 1000)}s.`],
    }
  }
  if (action.tool === "write") {
    const lines = action.content.replace(/\n$/u, "").split("\n")
    return { title: `Write ${action.path} (${lines.length} line${lines.length === 1 ? "" : "s"})`, preview: clip(lines.map(line => `+ ${line}`)) }
  }
  if (action.tool === "multiedit") {
    const files = [...new Set(action.edits.map(edit => edit.path))]
    const preview = action.edits.flatMap(edit => [
      `@ ${edit.path}`,
      ...edit.oldText.replace(/\n$/u, "").split("\n").map(line => `- ${line}`),
      ...edit.newText.replace(/\n$/u, "").split("\n").map(line => `+ ${line}`),
    ])
    return { title: `Edit ${files.length} file${files.length === 1 ? "" : "s"} (${action.edits.length} change${action.edits.length === 1 ? "" : "s"}): ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`,
      preview: clip(preview) }
  }
  const removed = action.oldText.replace(/\n$/u, "").split("\n").map(line => `- ${line}`)
  const added = action.newText.replace(/\n$/u, "").split("\n").map(line => `+ ${line}`)
  return { title: `Edit ${action.path} (-${removed.length} / +${added.length})`, preview: clip([...removed, ...added]) }
}

export type CommandResult = { ok: boolean; text: string; exitCode: number | null; signal: string | null; durationMs: number; status: "complete" | "error" | "cancelled" | "timeout"; lines: string[] }

export function packageInstallFailureHint(command: string, output: string): string | undefined {
  if (!/\bpip(?:3(?:\.\d+)?)?\s+install\b/u.test(command) ||
      !/Could not install packages due to an OSError/u.test(output) ||
      !/Operation not permitted|Permission denied|\[Errno (?:1|13)\]/u.test(output)) return undefined
  return "Package installation failed inside Python/pip, not at the Otter approval gate. " +
    "Inspect the selected interpreter, project environment and the denied path; an inaccessible editable install or .pth entry in the global environment can cause this. " +
    "Use the project's existing virtual environment or package manager. If none exists, propose creating a project .venv without system-site-packages, then install and run tests with that environment's Python through the normal approval gate. " +
    "Do not retry with sudo, chmod protected directories, delete global .pth registrations, or claim the package was installed."
}

/** Run a captured command (no terminal, no stdin) in the worktree; Esc/cancel or the time limit stops its group. */
export async function runCapturedCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
  const handle = startShell(command, { cwd, timeoutMs, maxOutputChars: COMMAND_OUTPUT_CHARS, env: { OTTER_CHAT_COMMAND: "1" } })
  const stop = () => handle.kill("cancelled")
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  try {
    const run = await handle.result
    const status = run.killed ? "cancelled" : run.timedOut ? "timeout" : run.ok ? "complete" : "error"
    const outcome = status === "cancelled" ? "cancelled by the user" : status === "timeout" ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : run.signal ? `signal ${run.signal}` : `exit ${run.exitCode ?? "?"}`
    const hint = status === "error" ? packageInstallFailureHint(command, run.output) : undefined
    const output = [run.output, ...(hint ? [`[otter] ${hint}`] : [])].filter(Boolean).join("\n")
    return {
      ok: status === "complete", exitCode: run.exitCode, signal: run.signal, durationMs: run.ms, status,
      text: `${outcome}\n${output || "(no output)"}`, lines: output ? output.split("\n").slice(-200) : [],
    }
  } finally {
    signal.removeEventListener("abort", stop)
  }
}

/** Run an interactive command with the real terminal (the caller has released it); no output is captured. */
export async function runInteractiveCommand(command: string, cwd: string): Promise<CommandResult> {
  const run = await runTerminalShell(command, cwd)
  const outcome = run.status === "cancelled" ? "cancelled by the user" : run.signal ? `signal ${run.signal}` : `exit ${run.exitCode ?? "?"}`
  return { ok: run.status === "complete", exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs, status: run.status,
    text: `${outcome}\n(ran interactively in the user's terminal; output was not captured)`, lines: [] }
}
