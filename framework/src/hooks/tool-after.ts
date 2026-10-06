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
import { activeWorkflow } from "../flow/state.ts"
import { flowOn } from "../flow/status.ts"
import { settle } from "../flow/runtime.ts"
import { getQueue } from "../orchestration/queue.ts"
import { isErrorOutput, PATH_TOOLS, relativizePaths } from "../hosts/tool-policy.ts"
import { getOpenCodeRuntime, policyForOpenCodeSession } from "../hosts/opencode-runtime.ts"

export function createToolAfterHook(deps: HookDeps): NonNullable<Hooks["tool.execute.after"]> {
  const guards = getGuards(deps)
  const runtime = getOpenCodeRuntime(deps)
  const repeatOn = enabled(deps.config, "guard.repeat")
  const trimOn = enabled(deps.config, "guard.trim")
  const recoverOn = enabled(deps.config, "guard.recover")

  return async (input, output) => {
    const bound = policyForOpenCodeSession(deps, input.sessionID)
    if (bound) {
      const shaped = bound.toolResult({ type: "tool-result", sessionID: input.sessionID, callID: input.callID, toolID: input.callID, name: input.tool, result: output.output })
      if (typeof shaped.error === "string") output.output = shaped.error
      else if (typeof shaped.result === "string") output.output = shaped.result
      const meta = output.metadata && typeof output.metadata === "object" ? output.metadata : {}
      output.metadata = { ...meta, lca: { trimmed: shaped.trimmed ?? false, hinted: shaped.hinted ?? false } }
      return
    }
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

    // §5.5/§5.2: a delegate call returning in the owning session settles the workflow (T15/T16, or the T18
    // pendingCancel completion once the queue has wound down).
    if (input.tool === "delegate" && flowOn(deps.config)) {
      const wf = activeWorkflow(deps.worktree)
      if (wf && wf.sessionID === input.sessionID) {
        try {
          settle(runtime, wf, getQueue(runtime).isRunning(input.sessionID))
        } catch (e) {
          deps.log("tool.execute.after: settle failed", { sessionID: input.sessionID, error: (e as Error).message })
        }
      }
    }
  }
}

function resetFailures(deps: HookDeps, sessionID: string): void {
  const state = readModeState(deps.worktree, sessionID)
  if (state.active && state.failures > 0) writeModeState(deps.worktree, sessionID, { ...state, failures: 0 })
}
