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
import { bashPolicyProblem } from "../flow/bash-policy.ts"
import { activeWorkflow, appendEvents, type Workflow } from "../flow/state.ts"
import { flowOn } from "../flow/status.ts"
import { isReviewSession, reviewToolCapProblem } from "../flow/review.ts"
import { observeSkillAttempt } from "../telemetry/skill-observer.ts"
import { markOpenCodeProcessRiskForSession, policyForOpenCodeSession } from "../hosts/opencode-runtime.ts"

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

// §5.4 planning boundary allowlist: read-only tools while the owning session's workflow is planning/reviewing/
// pending_approval or stuck(plan_invalid|no_submission). bash is allowed subject to bashPolicyProblem.
const BOUNDARY_ALLOWED_TOOLS = new Set(["read", "glob", "grep", "list", "skill", "todowrite", "todoread", "lca_flow", "bash"])
const BOUNDARY_PHASES = new Set(["planning", "reviewing", "pending_approval"])
// While an approved plan executes, main may read, inspect with read-only bash, and resume the queue; writes go
// through the workers only.
const EXECUTING_ALLOWED_TOOLS = new Set([...BOUNDARY_ALLOWED_TOOLS, "delegate"])
const BOUNDARY_STUCK_CAUSES = new Set(["plan_invalid", "no_submission"])

function inPlanningBoundary(wf: Workflow): boolean {
  if (BOUNDARY_PHASES.has(wf.phase)) return true
  return wf.phase === "stuck" && !!wf.stuckCause && BOUNDARY_STUCK_CAUSES.has(wf.stuckCause)
}

export function createToolBeforeHook(deps: HookDeps): NonNullable<Hooks["tool.execute.before"]> {
  const guards = getGuards(deps)
  const repeatOn = enabled(deps.config, "guard.repeat")
  const wikiRawOn = enabled(deps.config, "guard.wiki_raw")
  const boundaryOn = enabled(deps.config, "guard.plan_boundary")

  return async (input, output) => {
    observeSkillAttempt(deps, input, output.args)
    if (isReviewSession(input.sessionID)) {
      const problem = reviewToolCapProblem(input.sessionID, deps.config.flow.review_max_tool_calls)
      if (problem) {
        deps.log("blocked tool in plan review session (tool-call cap)", { sessionID: input.sessionID, tool: input.tool })
        throw new Error(`lca: ${problem}`)
      }
    }

    if (wikiRawOn && wikiRawTarget(deps, input.tool, output.args)) {
      deps.log("blocked write to knowledge/raw", { sessionID: input.sessionID, tool: input.tool })
      throw new Error("lca: raw wiki sources are immutable; use `bun scripts/lca-wiki.ts register`.")
    }

    const bound = policyForOpenCodeSession(deps, input.sessionID)
    if (bound) {
      const decision = bound.beforeTool({ type: "tool-before", sessionID: input.sessionID, callID: input.callID, toolID: input.callID, name: input.tool, input: output.args })
      if (!decision.allow) throw new Error(decision.reason)
      if (input.tool === "bash") markOpenCodeProcessRiskForSession(deps, input.sessionID)
      return
    }

    // In interactive mode, a missing, foreign, terminal, or stuck workflow never unlocks main-session writes.
    // The read-only planning allowlist remains available so a failed chat-start hook cannot fail open. This is a
    // tool policy boundary, not OS containment; authenticated worker/reviewer sessions were handled above.
    if (deps.interactive) {
      const wf = activeWorkflow(deps.worktree)
      const ownRunnable = !!wf && wf.sessionID === input.sessionID && wf.phase !== "stuck"
        && (BOUNDARY_PHASES.has(wf.phase) || wf.phase === "executing")
      if (!ownRunnable) {
        const args = (output.args ?? {}) as Record<string, unknown>
        let ok = BOUNDARY_ALLOWED_TOOLS.has(input.tool)
        if (ok && input.tool === "bash") {
          ok = bashPolicyProblem(typeof args.command === "string" ? args.command : "") === null
        }
        if (!ok) {
          deps.log("blocked tool without an owned interactive workflow", { sessionID: input.sessionID, tool: input.tool, workflowID: wf?.id, phase: wf?.phase })
          if (wf?.sessionID === input.sessionID) {
            appendEvents(deps.worktree, [{ wf: wf.id, type: "boundary_denied", actor: "model_tool", data: { tool: input.tool, phase: wf.phase } }])
          }
          throw new Error("lca: interactive mode is read-only without an owned active plan workflow; /cancel does not enable direct edits.")
        }
      }
    }

    if (deps.interactive || (boundaryOn && flowOn(deps.config))) {
      const wf = activeWorkflow(deps.worktree)
      if (wf && wf.sessionID === input.sessionID) {
        if (inPlanningBoundary(wf)) {
          const args = (output.args ?? {}) as Record<string, unknown>
          let ok = BOUNDARY_ALLOWED_TOOLS.has(input.tool)
          if (ok && input.tool === "bash") {
            ok = bashPolicyProblem(typeof args.command === "string" ? args.command : "") === null
          }
          if (!ok) {
            deps.log("blocked tool in planning boundary", { sessionID: input.sessionID, tool: input.tool })
            appendEvents(deps.worktree, [{ wf: wf.id, type: "boundary_denied", actor: "model_tool", data: { tool: input.tool } }])
            throw new Error('lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.')
          }
        } else if (wf.phase === "executing") {
          const args = (output.args ?? {}) as Record<string, unknown>
          if (input.tool === "delegate") {
            if (args.resume !== true) {
              deps.log("blocked delegate in executing without forced resume", { sessionID: input.sessionID })
              throw new Error("lca: an approved plan is running; call delegate with resume:true only")
            }
            // Weak models re-send the approved task list with resume:true. The approved tasks already exist in the
            // ledger, so the list is dropped (never appended, never superseding the approved tasks) and the call
            // proceeds as a plain resume instead of looping on a refusal (observed live, M1 keyword e2e).
            if (Array.isArray(args.tasks) && args.tasks.length > 0) {
              deps.log("delegate in executing: dropped re-sent task list, resuming approved tasks", { sessionID: input.sessionID, dropped: args.tasks.length })
              appendEvents(deps.worktree, [{ wf: wf.id, type: "boundary_coerced", actor: "model_tool", data: { tool: "delegate", dropped: args.tasks.length } }])
              delete args.tasks
            }
          } else if (!EXECUTING_ALLOWED_TOOLS.has(input.tool) || (input.tool === "bash" && bashPolicyProblem(typeof args.command === "string" ? args.command : "") !== null)) {
            // The approved plan runs through the worker queue only; main must not implement it directly.
            deps.log("blocked tool while an approved plan is executing", { sessionID: input.sessionID, tool: input.tool })
            appendEvents(deps.worktree, [{ wf: wf.id, type: "boundary_denied", actor: "model_tool", data: { tool: input.tool, phase: "executing" } }])
            throw new Error("lca: an approved plan is running; call delegate with resume:true (workers implement it), or /cancel.")
          }
        }
      }
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
