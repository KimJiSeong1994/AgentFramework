// tool.execute.after: record outcome for the repeat guard, trim bulky outputs, then append a recovery hint
// (after trimming so the hint is never cut). Only runs for calls that returned normally; thrown tool errors are
// observed in the event hook (message.part.updated with state.status === "error").
import type { Hooks } from "@opencode-ai/plugin"
import { enabled, type HookDeps } from "./types.ts"
import { readModeState, writeModeState } from "../state/store.ts"
import { getGuards } from "../guards/registry.ts"
import { errorExcerpt } from "../guards/repeat.ts"
import { trimToolOutput } from "../guards/trim.ts"
import { appendHint, recoveryHint } from "../guards/recover.ts"

/** Tools whose output is mostly paths; the worktree prefix is pure prefill cost for the model. */
export const PATH_TOOLS: ReadonlySet<string> = new Set(["glob", "grep", "list", "read", "bash"])

/** Replace absolute worktree/directory prefixes with relative paths. Longest prefix first. */
export function relativizePaths(text: string, roots: string[]): string {
  let out = text
  const uniq = Array.from(new Set(roots.filter(Boolean).map((r) => r.replace(/\/+$/, "")))).sort((a, b) => b.length - a.length)
  for (const root of uniq) {
    out = out.split(root + "/").join("")
  }
  return out
}

/** Tools that returned normally but whose text still reads as a failure (e.g. tools that report errors as output). */
export const ERROR_OUTPUT = /^\s*(Error\b|error:|✗|Failed\b)/

export function isErrorOutput(output: string): boolean {
  return ERROR_OUTPUT.test(output ?? "")
}

export function createToolAfterHook(deps: HookDeps): NonNullable<Hooks["tool.execute.after"]> {
  const guards = getGuards(deps)
  const repeatOn = enabled(deps.config, "guard.repeat")
  const trimOn = enabled(deps.config, "guard.trim")
  const recoverOn = enabled(deps.config, "guard.recover")

  return async (input, output) => {
    const original = typeof output.output === "string" ? output.output : String(output.output ?? "")
    const ok = !isErrorOutput(original)

    if (repeatOn) guards.repeat.recordResult(input.sessionID, input.callID, ok, ok ? undefined : errorExcerpt(original))
    if (ok) resetFailures(deps, input.sessionID)

    let text = original
    let trimmed = false
    if (trimOn && deps.config.guards.relativize_paths && PATH_TOOLS.has(input.tool)) {
      text = relativizePaths(text, [deps.directory, deps.worktree])
    }
    if (trimOn) {
      const r = trimToolOutput(input.tool, text, deps.config.guards)
      text = r.output
      trimmed = r.trimmed
      if (trimmed) deps.log("trimmed tool output", { tool: input.tool, lines: r.originalLines, bytes: r.originalBytes })
    }

    let hinted = false
    if (recoverOn) {
      const hint = recoveryHint(input.tool, input.args, original)
      if (hint) {
        text = appendHint(text, hint)
        hinted = true
      }
    }

    output.output = text
    const meta = output.metadata && typeof output.metadata === "object" ? output.metadata : {}
    output.metadata = { ...meta, lca: { trimmed, hinted } }
  }
}

function resetFailures(deps: HookDeps, sessionID: string): void {
  const state = readModeState(deps.worktree, sessionID)
  if (state.active && state.failures > 0) writeModeState(deps.worktree, sessionID, { ...state, failures: 0 })
}
