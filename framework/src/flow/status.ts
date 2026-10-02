// `/status` (M0) and the future `lca status` CLI: derived only from workflow.json/archive + events + ledger + mode.
import type { HookDeps } from "../hooks/types.ts"
import { enabled } from "../hooks/types.ts"
import type { LcaConfig } from "../config.ts"
import { counts, readLedger, tasksForWorkflow } from "../state/ledger.ts"
import { readModeState } from "../state/store.ts"
import { authorize } from "./owner.ts"
import { liveness } from "./runtime.ts"
import { readEvents, readWorkflow, type Workflow } from "./state.ts"

export const STATUS_MARKER = "[lca status]"

export function flowOn(config: LcaConfig): boolean {
  return config.flow.enabled && enabled(config, "flow")
}

export type StatusJson = {
  workflow: null | {
    id: string; phase: string; stuckCause?: string; sessionID: string; ownerLive: boolean
    plan?: string; review?: string; tasks?: { total: number; done: number; open: number; failed: number }
    counters: Workflow["counters"]; pendingCancel: boolean
  }
  session: { id: string; mode: string; modeActive: boolean; queueRunning: boolean; ledger: Record<string, number> }
  events: Array<{ seq: number; type: string; to?: string }>
}

export function statusJson(deps: HookDeps, sessionID: string, queueRunning: boolean, now = Date.now()): StatusJson {
  const wf = readWorkflow(deps.worktree)
  const mode = readModeState(deps.worktree, sessionID)
  const ledger = readLedger(deps.worktree, sessionID)
  let workflow: StatusJson["workflow"] = null
  if (wf) {
    const live = authorize("status", wf.sessionID, wf, liveness(deps, now)).kind === "allow"
    const tagged = tasksForWorkflow(readLedger(deps.worktree, wf.sessionID), wf.id)
    workflow = {
      id: wf.id,
      phase: wf.phase,
      ...(wf.stuckCause ? { stuckCause: wf.stuckCause } : {}),
      sessionID: wf.sessionID,
      ownerLive: live,
      ...(wf.planRef ? { plan: wf.planRef.mdPath } : {}),
      ...(wf.review ? { review: `${wf.review.verdict}${wf.review.note ? ` (${wf.review.note})` : ""}` } : {}),
      ...(tagged.length
        ? { tasks: {
            total: tagged.length,
            done: tagged.filter((t) => t.status === "done").length,
            open: tagged.filter((t) => t.status === "pending" || t.status === "running").length,
            failed: tagged.filter((t) => t.status === "failed" || t.status === "cancelled").length,
          } }
        : {}),
      counters: wf.counters,
      pendingCancel: !!wf.pendingCancel,
    }
  }
  const events = wf ? readEvents(deps.worktree, wf.id).slice(-5).map((e) => ({ seq: e.seq, type: e.type, ...(e.to ? { to: e.to } : {}) })) : []
  return {
    workflow,
    session: { id: sessionID, mode: mode.mode, modeActive: mode.active, queueRunning, ledger: counts(ledger) },
    events,
  }
}

/** <= 25 lines, code-rendered; starts with STATUS_MARKER so e2e can prove the model did not write it. */
export function renderStatus(deps: HookDeps, sessionID: string, queueRunning: boolean, now = Date.now()): string {
  const s = statusJson(deps, sessionID, queueRunning, now)
  const lines = [STATUS_MARKER]
  const w = s.workflow
  if (!w) lines.push("workflow: none")
  else {
    const phase = w.stuckCause ? `${w.phase}(${w.stuckCause})` : w.phase
    const owner = w.sessionID === sessionID ? "this session" : `session ${w.sessionID}`
    lines.push(`workflow: ${w.id} ${phase}${w.pendingCancel ? " cancelling" : ""} — ${owner}${w.ownerLive ? "" : ", owner dead"}`)
    if (w.plan) lines.push(`plan: ${w.plan}`)
    if (w.review) lines.push(`review: ${w.review}`)
    if (w.tasks) lines.push(`plan tasks: ${w.tasks.done}/${w.tasks.total} done, ${w.tasks.open} open, ${w.tasks.failed} failed/cancelled`)
    const c = w.counters
    lines.push(`counters: invalid ${c.code_invalid}, review ${c.review_iterations}, rejects ${c.user_rejections}, nudges ${c.nudges}`)
  }
  const l = s.session.ledger
  lines.push(`mode: ${s.session.modeActive ? s.session.mode : "none"}`)
  lines.push(`ledger: ${l.done ?? 0} done, ${(l.pending ?? 0) + (l.running ?? 0)} open, ${l.failed ?? 0} failed, ${l.cancelled ?? 0} cancelled; queue ${s.session.queueRunning ? "running" : "idle"}`)
  if (s.events.length) lines.push(`events: ${s.events.map((e) => `#${e.seq} ${e.type}${e.to ? `→${e.to}` : ""}`).join(", ")}`)
  return lines.slice(0, 25).join("\n")
}
