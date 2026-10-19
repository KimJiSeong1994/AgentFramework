import { randomUUID } from "node:crypto"
import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import type { CoreDeps } from "../deps.ts"
import { containsSecret } from "../security/secrets.ts"
import { stateRoot } from "../state/store.ts"

export type RoutingScores = { choice: string; probabilities: Record<string, number>; confidence: number; margin: number }
export type RoutingDecision = {
  decisionID: string
  sessionID: string
  messageID: string
  mode: "off" | "shadow" | "suggest" | "auto" | "offer" | "invalid"
  skill: string | null
  reason: string
  elapsedMs: number
  requestSent: boolean
  candidates: string[]
  thresholds: { minProbability: number; minMargin: number; timeoutMs: number } | null
  scores: RoutingScores | null
  /** Judging engine (claude/codex/local/jev); absent means the OpenCode path's OpenJev. */
  engine?: string
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value) || containsSecret(value)) throw new Error("Invalid routing identifier")
  return value
}

/** Kept outside disposable session state so session deletion does not erase learning evidence. */
export function routingLogPath(worktree: string, sessionID: string): string {
  return join(stateRoot(worktree), "routing", `${identifier(sessionID)}.jsonl`)
}

function append(deps: CoreDeps, sessionID: string, event: Record<string, unknown>): void {
  const path = routingLogPath(deps.worktree, sessionID)
  const dir = join(stateRoot(deps.worktree), "routing")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("Invalid routing directory")
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Invalid routing log")
    fchmodSync(fd, 0o600)
    appendFileSync(fd, JSON.stringify({ schemaVersion: 1, eventID: randomUUID(), recordedAt: Date.now(), ...event }) + "\n")
  } finally {
    closeSync(fd)
  }
}

/** Logging is observational: disk errors never alter the routing result or expose payloads in warnings. */
function bestEffort(deps: CoreDeps, action: () => void): void {
  try { action() } catch {
    try { deps.log("skill.router persistence failed") } catch { /* Logging cannot affect routing. */ }
  }
}

export function recordRoutingDecision(deps: CoreDeps, decision: RoutingDecision): void {
  bestEffort(deps, () => {
    const d = decision
    const scores = d.scores && {
      choice: identifier(d.scores.choice), confidence: d.scores.confidence, margin: d.scores.margin,
      probabilities: Object.fromEntries(Object.entries(d.scores.probabilities).map(([name, p]) => [identifier(name), p])),
    }
    append(deps, d.sessionID, {
      event: "decision", decisionID: identifier(d.decisionID), sessionID: identifier(d.sessionID), messageID: identifier(d.messageID),
      model: d.engine === undefined || d.engine === "jev" ? "jev-latest" : identifier(d.engine), mode: d.mode, skill: d.skill === null ? null : identifier(d.skill), reason: identifier(d.reason),
      elapsedMs: d.elapsedMs, requestSent: d.requestSent, candidates: d.candidates.map(identifier),
      thresholds: d.thresholds && { minProbability: d.thresholds.minProbability, minMargin: d.thresholds.minMargin, timeoutMs: d.thresholds.timeoutMs }, scores,
    })
  })
}

/**
 * `otter chat` model-driven skill load through the `skill` tool: `loaded` when the instructions were returned to the
 * model, otherwise why not (`refused`, `superseded`). Content-free: names and outcome only.
 */
export function recordSkillToolLoad(deps: CoreDeps, sessionID: string, turnID: string, skill: string, outcome: string): void {
  bestEffort(deps, () => append(deps, sessionID, {
    event: "skill_tool_load", sessionID: identifier(sessionID), turnID: identifier(turnID),
    skill: identifier(skill), outcome: identifier(outcome),
  }))
}

/** Emitted only after the hook actually inserts advice; recommendation is not evidence of skill execution. */
export function recordRoutingAdvice(deps: CoreDeps, sessionID: string, messageID: string, decisionID: string, skill: string): void {
  bestEffort(deps, () => append(deps, sessionID, {
    event: "advice_applied", decisionID: identifier(decisionID), sessionID: identifier(sessionID),
    messageID: identifier(messageID), skill: identifier(skill),
  }))
}
