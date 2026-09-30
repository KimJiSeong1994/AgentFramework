// tool.execute.before: repeat-call blocker + defensive `task` block for non-main agents.
// Throwing here reaches the model: OpenCode wraps the hook inside the AI-SDK tool execute (session/tools.ts), the
// AI SDK turns the rejection into `tool-error`, the processor stores ToolStateError.error and message-v2 sends it
// to the model as `errorText`. tool.execute.after is NOT called for a thrown call.
import type { Hooks } from "@opencode-ai/plugin"
import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { enabled, type HookDeps } from "./types.ts"
import { readJson, sessionInfoPath, type SessionInfo } from "../state/store.ts"
import { getGuards } from "../guards/registry.ts"
import { repeatBlockMessage } from "../guards/repeat.ts"

export const MAIN_AGENT = "main"

/** Tools whose target path is a plain argument. */
const PATH_WRITE_TOOLS = new Set(["edit", "write", "multiedit"])
/** Tools whose targets live inside `patchText` marker lines (OpenCode `apply_patch`; `patch` on newer hosts). */
const PATCH_TOOLS = new Set(["apply_patch", "patch"])
// Hosts trim lines before matching headers (streaming apply_patch), so indentation must not hide a target.
const PATCH_TARGET = /^[ \t]*\*\*\*[ \t]*(?:Add File|Update File|Delete File|Move to)[ \t]*:[ \t]*(.+?)[ \t]*\r?$/gim

/** Resolve through the nearest existing ancestor so symlink aliases (e.g. /var -> /private/var) compare equal. */
function canonical(path: string): string {
  let base = path
  const rest: string[] = []
  for (;;) {
    try { return join(realpathSync.native(base), ...rest) } catch {
      const parent = dirname(base)
      if (parent === base) return path
      rest.unshift(basename(base))
      base = parent
    }
  }
}

/**
 * Case-insensitive comparison: macOS/Windows default volumes treat `knowledge/RAW` as `knowledge/raw`. On a
 * case-sensitive volume this also refuses a genuinely distinct `Knowledge/Raw`; failing closed there is intended.
 */
function insideRaw(deps: HookDeps, target: string): boolean {
  const rawRoot = canonical(resolve(deps.worktree, "knowledge", "raw")).toLowerCase()
  const path = canonical(isAbsolute(target) ? target : resolve(deps.directory, target)).toLowerCase()
  return path === rawRoot || path.startsWith(rawRoot + sep)
}

function writeTargets(tool: string, args: Record<string, unknown>): string[] {
  if (PATH_WRITE_TOOLS.has(tool)) {
    const raw = args.filePath ?? args.path
    return typeof raw === "string" && raw ? [raw] : []
  }
  if (PATCH_TOOLS.has(tool)) {
    const text = args.patchText ?? args.patch
    // Also check the unquoted form: blocking either reading fails closed.
    return typeof text === "string"
      ? [...text.matchAll(PATCH_TARGET)].flatMap((m) => [m[1]!, m[1]!.replace(/^(["'`])(.*)\1$/, "$2")])
      : []
  }
  return []
}

// Raw wiki sources are immutable once registered; only `scripts/lca-wiki.ts register` may write under knowledge/raw/.
// bash is not parsed; lint's byte-integrity check is the backstop for anything written outside these tools.
export function wikiRawTarget(deps: HookDeps, tool: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  return writeTargets(tool, args as Record<string, unknown>).find((t) => insideRaw(deps, t)) ?? null
}

export function createToolBeforeHook(deps: HookDeps): NonNullable<Hooks["tool.execute.before"]> {
  const guards = getGuards(deps)
  const repeatOn = enabled(deps.config, "guard.repeat")
  const wikiRawOn = enabled(deps.config, "guard.wiki_raw")

  return async (input, output) => {
    if (wikiRawOn && wikiRawTarget(deps, input.tool, output.args)) {
      deps.log("blocked write to knowledge/raw", { sessionID: input.sessionID, tool: input.tool })
      throw new Error("lca: raw wiki sources are immutable; use `bun scripts/lca-wiki.ts register`.")
    }

    if (input.tool === "task") {
      const info = readJson<SessionInfo | null>(sessionInfoPath(deps.worktree, input.sessionID), null)
      const agent = info?.agent
      if (agent && agent !== MAIN_AGENT) {
        deps.log("blocked task from non-main agent", { sessionID: input.sessionID, agent })
        throw new Error(`lca: the task tool is only available to the ${MAIN_AGENT} agent (current agent: ${agent}). Do the work directly.`)
      }
    }

    if (!repeatOn) return
    const res = guards.repeat.check(input.sessionID, input.tool, output.args, input.callID)
    if (res.blocked) {
      deps.log("blocked repeated call", { sessionID: input.sessionID, tool: input.tool, count: res.count })
      throw new Error(repeatBlockMessage(input.tool, res.count, res.lastError))
    }
  }
}
