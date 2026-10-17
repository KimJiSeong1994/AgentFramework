import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { isAbsolute } from "node:path"
import type { CoreDeps } from "../deps.ts"
import { containsSecret } from "../security/secrets.ts"
import {
  admitSkillCall, recordSkillCall, recordSkillTurn, recordSkillTask, recordSkillVerification,
  recordRelatedTool, getSkillCampaignStatus, maintainSkillCampaign, markSkillSessionBoundary,
  skillObservationBindingHash, validSkillCampaignID,
  type SkillTurnFactInput, type SkillTaskFactInput, type SkillVerificationFactInput,
} from "./skills.ts"
import { fingerprintSkillObservation, SUPPORTED_SKILL_RENDERER } from "./skill-evaluation.ts"

const warnings = new Set<string>()
const maintenanceTimers = new Map<string, ReturnType<typeof setInterval>>()
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value) && !containsSecret(value)

function observationTimes(value: unknown) {
  const time = record(value)
  const now = Date.now()
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= now
  let startedAt = valid(time.start) ? time.start : null
  let finishedAt = valid(time.end) ? time.end : null
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) startedAt = finishedAt = null
  return { startedAt, finishedAt, durationMs: startedAt !== null && finishedAt !== null ? finishedAt - startedAt : null }
}

function warning(deps: CoreDeps, code: string): void {
  const key = `${deps.worktree}\0${code}`
  if (warnings.has(key)) return
  warnings.add(key)
  if (warnings.size > 64) warnings.delete(warnings.values().next().value!)
  // Fixed codes only: failures are visible without OTTER_DEBUG, never echo inputs or storage paths.
  try { console.warn(`[otter] skill observation: ${code}`) } catch { /* Observational only. */ }
}

export function skillObservationBinding(deps: CoreDeps): { root: string; campaignID: string } | null {
  const config = record(deps.config.skill_observation)
  if (config.enabled !== true || deps.config.disabled_hooks.includes("tool.history")) return null
  if (!validSkillCampaignID(config.campaign_id) || (config.owner_root !== undefined && (typeof config.owner_root !== "string" || !isAbsolute(config.owner_root)))) {
    warning(deps, "invalid_config")
    return null
  }
  try {
    const root = realpathSync.native(typeof config.owner_root === "string" ? config.owner_root : deps.worktree)
    if (root !== realpathSync.native(deps.worktree)) {
      warning(deps, "unsupported_cross_instance")
      return null
    }
    if (typeof config.owner_binding !== "string" || config.owner_binding !== skillObservationBindingHash(root)) {
      warning(deps, "binding_mismatch")
      return null
    }
    return { root, campaignID: config.campaign_id }
  } catch { warning(deps, "binding_unavailable"); return null }
}

function observe(deps: CoreDeps, action: (binding: { root: string; campaignID: string }) => unknown): void {
  try {
    const binding = skillObservationBinding(deps)
    if (!binding) return
    const result = record(action(binding))
    if ((result.recorded === false || result.admitted === false) && !["replay", "closed", "draining", "quota_limit"].includes(String(result.code))) warning(deps, "record_refused")
  } catch { warning(deps, "storage_unavailable") }
}

/** Maintenance never creates telemetry and remains independent from tool execution. */
export function initializeSkillObservation(deps: CoreDeps): void {
  try {
    const binding = skillObservationBinding(deps)
    if (!binding && deps.config.skill_observation?.enabled === true) return
    const root = binding?.root ?? deps.worktree
    const status = getSkillCampaignStatus(root)
    if (!status.available || !status.campaignID) {
      if (binding) warning(deps, "storage_unavailable")
      return
    }
    if (binding && binding.campaignID !== status.campaignID) {
      warning(deps, "campaign_mismatch")
      return
    }
    const campaignID = status.campaignID
    const key = `${root}\0${campaignID}`
    const maintain = () => {
      const result = maintainSkillCampaign(root, campaignID)
      if (!result.available) warning(deps, "maintenance_unavailable")
    }
    maintain()
    if (maintenanceTimers.has(key)) return
    if (maintenanceTimers.size >= 32) { warning(deps, "maintenance_capacity"); return }
    const timer = setInterval(maintain, 60_000)
    timer.unref()
    maintenanceTimers.set(key, timer)
  } catch { warning(deps, "maintenance_unavailable") }
}

export function observationConfigGeneration(deps: CoreDeps): string | null {
  const router = deps.config.skill_router
  const allow = deps.config.skills.allow
  if (!Array.isArray(allow) || allow.length > 16) return null
  const names = allow.filter((name) => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) && !containsSecret(name))
  if (names.length !== allow.length) return null
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null
  return createHash("sha256").update(JSON.stringify({
    basis: "otter-observation-config.v1",
    enabled: deps.config.skill_observation?.enabled === true,
    history: !deps.config.disabled_hooks.includes("tool.history"), routerMode: ["off", "shadow", "suggest"].includes(router.mode) ? router.mode : "invalid",
    probability: number(router.min_probability), margin: number(router.min_margin), timeoutMs: number(router.timeout_ms),
    allow: names, allowComplete: names.length === allow.length, flow: deps.config.flow?.enabled === true,
    modeDetection: !deps.config.disabled_hooks.includes("mode.detect"), agentConfiguration: !deps.config.disabled_hooks.includes("config.agents"),
  })).digest("hex")
}

/** Called before existing tool refusal checks; admission is permission to observe, not permission to execute. */
export function observeSkillAttempt(deps: CoreDeps, input: { tool: string; sessionID: string; callID: string }, args: unknown): void {
  if (input.tool !== "skill") return
  observe(deps, ({ root, campaignID }) => {
    const admitted = admitSkillCall(root, campaignID, { sessionID: input.sessionID, callID: input.callID, stage: "before" })
    if (!admitted.admitted) return { recorded: false, code: admitted.code }
    return recordSkillCall(root, admitted.token, { state: "pending", returnedContent: "unknown", requestedName: record(args).name })
  })
}

/** Inspect/hashes content only after atomic quota admission; closed campaigns never read output bodies. */
export function observeSkillPart(deps: CoreDeps, value: unknown): void {
  const part = record(value)
  if (part.tool !== "skill") return
  const state = record(part.state)
  const terminal = state.status === "completed" || state.status === "error"
  if (!terminal && state.status !== "pending" && state.status !== "running") return
  observe(deps, ({ root, campaignID }) => {
    const times = observationTimes(state.time)
    const admitted = admitSkillCall(root, campaignID, {
      sessionID: part.sessionID as string, callID: part.callID as string,
      stage: terminal ? "terminal" : state.status as "pending" | "running", ...times,
    })
    if (!admitted.admitted) return { recorded: false, code: admitted.code }
    const args = record(state.input)
    const metadata = record(state.metadata)
    const time = record(state.time)
    const flags = record(metadata.otter)
    const fingerprints = state.status === "completed" ? fingerprintSkillObservation({
      requestedName: args.name, returnedName: metadata.name, output: state.output, metadata,
      renderer: SUPPORTED_SKILL_RENDERER, projectRoot: deps.worktree,
      truncated: metadata.truncated === true, compacted: time.compacted !== undefined,
      modified: flags.trimmed === true || flags.hinted === true,
    }) : { requestedName: args.name, returnedContent: state.status === "error" ? "not_returned" : "unknown" }
    return recordSkillCall(root, admitted.token, {
      ...fingerprints, state: terminal ? state.status : "pending", messageID: identifier(part.messageID) ? part.messageID : null,
      ...times,
    })
  })
}

export function observeRelatedToolPart(deps: CoreDeps, value: unknown): void {
  const part = record(value)
  if (part.tool === "skill" || !identifier(part.tool) || !identifier(part.sessionID) || !identifier(part.callID)) return
  const state = record(part.state)
  const terminal = state.status === "completed" || state.status === "error"
  if (!terminal && state.status !== "pending" && state.status !== "running") return
  observe(deps, ({ root, campaignID }) => recordRelatedTool(root, campaignID, {
    sessionID: part.sessionID as string, callID: part.callID as string, tool: part.tool as string,
    messageID: identifier(part.messageID) ? part.messageID : null,
    phase: terminal ? "terminal" : "pending", status: terminal ? state.status as "completed" | "error" : "pending",
    ...observationTimes(state.time),
  }))
}

export function observeSkillBoundary(deps: CoreDeps, sessionID: string, reason: "compacted" | "deleted"): void {
  observe(deps, ({ root, campaignID }) => markSkillSessionBoundary(root, campaignID, sessionID, reason))
}

export function observeSkillTurn(deps: CoreDeps, fact: SkillTurnFactInput): void {
  observe(deps, ({ root, campaignID }) => recordSkillTurn(root, campaignID, fact))
}

export function observeSkillTask(deps: CoreDeps, fact: SkillTaskFactInput): void {
  observe(deps, ({ root, campaignID }) => recordSkillTask(root, campaignID, fact))
}

export function observeSkillVerification(deps: CoreDeps, fact: SkillVerificationFactInput): void {
  observe(deps, ({ root, campaignID }) => recordSkillVerification(root, campaignID, fact))
}

/** Parent IDs supplied by the host only. Never infer parentage from the latest user message. */
export function observeSkillMessage(deps: CoreDeps, value: unknown): void {
  const info = record(value)
  if (!identifier(info.sessionID) || !identifier(info.id)) return
  const role = info.role === "user" || info.role === "assistant" ? info.role : "unknown"
  const time = record(info.time)
  const times = observationTimes({ start: time.created, end: time.completed })
  const terminal = role === "assistant" && times.finishedAt !== null
  const complete = terminal && info.finish === "stop"
  observeSkillTurn(deps, {
    sessionID: info.sessionID, messageID: info.id, role,
    phase: terminal ? "terminal" : "pending",
    parentMessageID: identifier(info.parentID) ? info.parentID : null,
    actualAgent: identifier(info.agent) ? info.agent : null,
    agentBasis: identifier(info.agent) ? "sdk_agent_field" : "unknown",
    actualModel: typeof info.providerID === "string" && typeof info.modelID === "string" ? `${info.providerID}/${info.modelID}` : null,
    modelBasis: typeof info.providerID === "string" && typeof info.modelID === "string" ? "sdk_model_field" : "unknown",
    closureReason: terminal ? "completed" : "unknown",
    startedAt: times.startedAt, finishedAt: times.finishedAt,
  })
  if (complete && identifier(info.parentID)) observeSkillTurn(deps, {
    sessionID: info.sessionID, messageID: info.parentID, role: "user", phase: "terminal", closureReason: "completed", finishedAt: times.finishedAt,
  })
}
