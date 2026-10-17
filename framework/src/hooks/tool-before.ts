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
import {
  activeWorkflow, appendEvents, assertFlowTxWorktree, workflowReadError, readWorkflowForWrite,
  workflowEngineRefusal, withFlowTransaction, type Workflow,
} from "../flow/state.ts"
import { flowOn } from "../flow/status.ts"
import { assertNever, type Phase } from "../workflows/types.ts"
import { isReviewSession, reviewToolCapProblem } from "../flow/review.ts"
import { observeSkillAttempt } from "../telemetry/skill-observer.ts"
import { captureToolEpoch, recordToolObservation, type ToolObservationStatus } from "../hosts/tool-observation.ts"
import { getOpenCodeRuntime, markOpenCodeProcessRiskForSession, policyForOpenCodeSession } from "../hosts/opencode-runtime.ts"
import { admissionEpoch, effectiveHold } from "../sessions/admission.ts"
import { admitOpenCodeToolCall, completeOpenCodeToolCall, openCodeToolCallArgumentsMatch } from "../hosts/opencode-tool-call.ts"
import { beforeOpenCodeSkillTool } from "../skills/opencode.ts"

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

// Raw wiki sources are immutable once registered; only `scripts/otter-wiki.ts register` may write under knowledge/raw/.
// bash is not parsed; lint's byte-integrity check is the backstop for anything written outside these tools.
export function wikiRawTarget(deps: HookDeps, tool: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  return writeTargets(tool, args as Record<string, unknown>).find((t) => insideRaw(deps, t)) ?? null
}

// §5.4 planning boundary allowlist: read-only tools while the owning session's workflow is planning/reviewing/
// pending_approval or stuck(plan_invalid|no_submission). bash is allowed subject to bashPolicyProblem.
const BOUNDARY_ALLOWED_TOOLS = new Set(["read", "glob", "grep", "list", "memory", "skill", "todowrite", "todoread", "otter_flow", "bash"])
const BOUNDARY_PHASES = new Set<Phase>(["planning", "reviewing", "pending_approval"])
// While an approved plan executes, main may read, inspect with read-only bash, and resume the queue; writes go
// through the workers only.
const EXECUTING_ALLOWED_TOOLS = new Set([...BOUNDARY_ALLOWED_TOOLS, "delegate"])
const BOUNDARY_STUCK_CAUSES = new Set(["plan_invalid", "no_submission"])

function inPlanningBoundary(wf: Workflow): boolean {
  switch (wf.phase) {
    case "planning": case "reviewing": case "pending_approval": return true
    case "stuck": return !!wf.stuckCause && BOUNDARY_STUCK_CAUSES.has(wf.stuckCause)
    // A paused workflow is neither a planning boundary nor an executing one: nothing is allowed through either gate.
    case "executing": case "paused": case "done": case "cancelled": return false
    default: return assertNever(wf.phase, "workflow phase")
  }
}

function appendWorkflowEvent(
  deps: HookDeps,
  expected: Workflow,
  type: "boundary_denied" | "boundary_coerced",
  data: Record<string, unknown>,
): boolean {
  const runtime = getOpenCodeRuntime(deps)
  return withFlowTransaction(deps.worktree, (tx) => {
    assertFlowTxWorktree(tx, deps.worktree)
    const checked = readWorkflowForWrite(tx)
    if (checked.corrupt) throw workflowReadError(checked)
    const current = checked.wf
    if (!current || workflowEngineRefusal(current, runtime.host.identity.engine) || current.id !== expected.id ||
        current.engine !== expected.engine || current.phase !== expected.phase || current.lastSeq !== expected.lastSeq) return false
    appendEvents(tx, [{ wf: current.id, type, actor: "model_tool", data }])
    return true
  })
}

export function createToolBeforeHook(deps: HookDeps): NonNullable<Hooks["tool.execute.before"]> {
  const guards = getGuards(deps)
  const repeatOn = enabled(deps.config, "guard.repeat")
  const wikiRawOn = enabled(deps.config, "guard.wiki_raw")
  const boundaryOn = enabled(deps.config, "guard.plan_boundary")

  return async (input, output) => {
    const call = await admitOpenCodeToolCall(deps, input, output.args)
    if (!call) return
    await beforeOpenCodeSkillTool(deps, call, output.args)
    if (!openCodeToolCallArgumentsMatch(deps, call, output.args)) throw new Error("otter: tool arguments or authority changed before dispatch")
    const observe = (status: ToolObservationStatus) => recordToolObservation(deps.worktree, {
      name: input.tool,
      callID: input.callID,
      sessionID: input.sessionID,
      status,
    })
    const deny = (error: Error): never => {
      observe("denied")
      completeOpenCodeToolCall(deps, call)
      throw error
    }

    observeSkillAttempt(deps, input, output.args)
    if (isReviewSession(input.sessionID)) {
      const problem = reviewToolCapProblem(input.sessionID, deps.config.flow.review_max_tool_calls)
      if (problem) {
        deps.log("blocked tool in plan review session (tool-call cap)", { sessionID: input.sessionID, tool: input.tool })
        deny(new Error(`otter: ${problem}`))
      }
    }

    if (wikiRawOn && wikiRawTarget(deps, input.tool, output.args)) {
      deps.log("blocked write to knowledge/raw", { sessionID: input.sessionID, tool: input.tool })
      deny(new Error("otter: raw wiki sources are immutable; use `bun scripts/otter-wiki.ts register`."))
    }

    const bound = policyForOpenCodeSession(deps, input.sessionID)
    if (!bound && effectiveHold(deps.worktree, input.sessionID)) {
      deny(new Error("otter: session held; explicit owner Resume is required before tool dispatch"))
    }
    if (!bound) {
      const epoch = admissionEpoch(deps.worktree, input.sessionID)
      if (!epoch) deny(new Error("otter: live tool admission epoch is missing"))
      captureToolEpoch(deps.worktree, input.sessionID, input.callID, epoch!)
    }
    if (bound) {
      const decision = bound.beforeTool({ type: "tool-before", sessionID: input.sessionID, callID: input.callID, toolID: input.callID, name: input.tool, input: output.args })
      if (!decision.allow) deny(new Error(decision.reason))
      if (!openCodeToolCallArgumentsMatch(deps, call, output.args)) deny(new Error("otter: tool authority changed during policy admission"))
      if (input.tool === "bash") markOpenCodeProcessRiskForSession(deps, input.sessionID)
      observe("running")
      return
    }

    // In interactive mode, a missing, foreign, terminal, or stuck workflow never unlocks main-session writes.
    // The read-only planning allowlist remains available so a failed chat-start hook cannot fail open. This is a
    // tool policy boundary, not OS containment; authenticated worker/reviewer sessions were handled above.
    if (deps.interactive) {
      const wf = activeWorkflow(deps.worktree)
      const runtime = wf ? getOpenCodeRuntime(deps) : undefined
      const ownRunnable = !!wf && !workflowEngineRefusal(wf, runtime!.host.identity.engine) && wf.sessionID === input.sessionID && wf.phase !== "stuck"
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
            appendWorkflowEvent(deps, wf, "boundary_denied", { tool: input.tool, phase: wf.phase })
          }
          deny(new Error("otter: interactive mode is read-only without an owned active plan workflow; /cancel does not enable direct edits."))
        }
      }
    }

    if (deps.interactive || (boundaryOn && flowOn(deps.config))) {
      const wf = activeWorkflow(deps.worktree)
      if (wf && wf.sessionID === input.sessionID) {
        const engineRefusal = workflowEngineRefusal(wf, getOpenCodeRuntime(deps).host.identity.engine)
        if (engineRefusal && input.tool === "delegate") {
          deps.log("blocked delegate without matching workflow engine identity", { sessionID: input.sessionID, workflowID: wf.id, reason: engineRefusal })
          deny(new Error(`otter: ${engineRefusal}`))
        }
        if (inPlanningBoundary(wf)) {
          const args = (output.args ?? {}) as Record<string, unknown>
          let ok = BOUNDARY_ALLOWED_TOOLS.has(input.tool)
          if (ok && input.tool === "bash") {
            ok = bashPolicyProblem(typeof args.command === "string" ? args.command : "") === null
          }
          if (!ok) {
            deps.log("blocked tool in planning boundary", { sessionID: input.sessionID, tool: input.tool })
            appendWorkflowEvent(deps, wf, "boundary_denied", { tool: input.tool })
            deny(new Error('otter: planning phase — read-only. Submit the plan with otter_flow op:"plan", or /cancel.'))
          }
        } else if (wf.phase === "executing") {
          const args = (output.args ?? {}) as Record<string, unknown>
          if (input.tool === "delegate") {
            if (args.resume !== true) {
              deps.log("blocked delegate in executing without forced resume", { sessionID: input.sessionID })
              deny(new Error("otter: an approved plan is running; call delegate with resume:true only"))
            }
            // The canonical call proof binds exact arguments; never silently rewrite them after admission.
            if (Array.isArray(args.tasks) && args.tasks.length > 0) {
              appendWorkflowEvent(deps, wf, "boundary_denied", { tool: "delegate", reason: "resume includes tasks" })
              deny(new Error("otter: delegate resume must omit tasks; retry with the exact approved resume arguments"))
            }
          } else if (!EXECUTING_ALLOWED_TOOLS.has(input.tool) || (input.tool === "bash" && bashPolicyProblem(typeof args.command === "string" ? args.command : "") !== null)) {
            // The approved plan runs through the worker queue only; main must not implement it directly.
            deps.log("blocked tool while an approved plan is executing", { sessionID: input.sessionID, tool: input.tool })
            appendWorkflowEvent(deps, wf, "boundary_denied", { tool: input.tool, phase: "executing" })
            deny(new Error("otter: an approved plan is running; call delegate with resume:true (workers implement it), or /cancel."))
          }
        }
      }
    }

    if (input.tool === "task") {
      const info = readJson<SessionInfo | null>(sessionInfoPath(deps.worktree, input.sessionID), null)
      const agent = info?.agent
      if (agent && agent !== MAIN_AGENT) {
        deps.log("blocked task from non-main agent", { sessionID: input.sessionID, agent })
        deny(new Error(`otter: the task tool is only available to the ${MAIN_AGENT} agent (current agent: ${agent}). Do the work directly.`))
      }
    }

    if (repeatOn) {
      const res = guards.repeat.check(input.sessionID, input.tool, output.args, input.callID)
      if (res.blocked) {
        deps.log("blocked repeated call", { sessionID: input.sessionID, tool: input.tool, count: res.count })
        deny(new Error(repeatBlockMessage(input.tool, res.count, res.lastError)))
      }
    }
    if (!openCodeToolCallArgumentsMatch(deps, call, output.args)) deny(new Error("otter: tool authority changed before effect"))
    observe("running")
  }
}
