// Session digests: a deterministic summary of one chat session, written when the session ends. No model call.
//
// Allow-list (knowledge/AGENTS.md "세션 다이제스트"): session identity, engine/model/routes, times, counts of turns, tools and
// decisions, the worktree-relative paths approved actions wrote, the commands it ran as rule prefixes (`bun test`) with
// their exit status and duration, workflow IDs with their last stage, and an outcome class. Never message text, file
// contents, edit text, full command lines, command output or credentials. Digests live in the state directory (outside
// the worktree); the wiki capture copies them into knowledge/raw only for projects that keep a wiki.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { commandRule } from "../hosts/chat-actions.ts"
import { stateRoot } from "../state/store.ts"
import { readSessionMetadata, replaySession, type TranscriptRecord } from "./store.ts"

export const DIGEST_SCHEMA_VERSION = 1
const MAX_FILES = 200
const MAX_COMMANDS = 200
const MAX_WORKFLOWS = 32
const MAX_DIGESTS_READ = 500
const PAGE = 2000

export type DigestCommand = { rule: string; status: "complete" | "error" | "cancelled" | "timeout"; exitCode: number | null; durationMs: number }

export type SessionDigest = {
  schemaVersion: 1
  kind: "session-digest"
  sessionID: string
  engine: string
  model: string | null
  routes: Record<string, { engine: string; model: string }>
  startedAt: number | null
  endedAt: number
  turns: number
  tools: Record<string, { succeeded: number; failed: number; denied: number }>
  decisions: Record<string, number>
  /** Worktree-relative paths written by allowed write/edit/multiedit actions (deduplicated, first 200). */
  files: string[]
  /** Commands run through chat execution or `!command`, as rule prefixes; chained/compound commands are "(compound)". */
  commands: DigestCommand[]
  workflows: Array<{ id: string; stage: string }>
  /** completed: the last turn got an answer; abandoned: the session ended on an unanswered or failed turn. */
  outcome: "completed" | "abandoned"
  /** False when the session transcript could not be read in full; the digest then covers what was read. */
  complete: boolean
}

export function digestDirectory(worktree: string): string {
  return join(stateRoot(worktree), "digests")
}

function digestPath(worktree: string, sessionID: string): string {
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(sessionID)) throw new TypeError("invalid session ID for a digest")
  return join(digestDirectory(worktree), `${sessionID}.json`)
}

function allRecords(worktree: string, sessionID: string): { records: TranscriptRecord[]; complete: boolean } {
  const records: TranscriptRecord[] = []
  let offset = 0
  for (;;) {
    const page = replaySession(worktree, sessionID, { offset, limit: PAGE })
    records.push(...page.records)
    if (!page.complete) return { records, complete: false }
    if (page.nextOffset === undefined || page.records.length === 0) return { records, complete: true }
    offset = page.nextOffset
  }
}

/** Build the digest of one session from its transcript (pure read). */
export function buildSessionDigest(worktree: string, sessionID: string, endedAt = Date.now()): SessionDigest {
  const metadata = readSessionMetadata(worktree, sessionID)
  const { records, complete } = allRecords(worktree, sessionID)
  const tools: SessionDigest["tools"] = {}
  const decisions: Record<string, number> = {}
  const files = new Set<string>()
  const commands: DigestCommand[] = []
  const workflows = new Map<string, string>()
  let turns = 0
  let lastKind: string | undefined
  for (const record of records) {
    const data = record.data
    if (record.kind === "user") turns++
    if (record.kind === "user" || record.kind === "assistant") lastKind = record.kind
    if ((record.kind === "tool-result" || record.kind === "tool-denied") && typeof data.name === "string") {
      const entry = tools[data.name] ??= { succeeded: 0, failed: 0, denied: 0 }
      if (data.outcome === "succeeded") entry.succeeded++
      else if (data.outcome === "denied") entry.denied++
      else entry.failed++
    }
    if (record.kind === "action" && typeof data.decision === "string") {
      decisions[data.decision] = (decisions[data.decision] ?? 0) + 1
      const allowed = data.decision !== "denied" && data.decision !== "refused"
      if (allowed && Array.isArray(data.paths)) for (const path of data.paths) if (typeof path === "string" && files.size < MAX_FILES) files.add(path)
    }
    if (record.kind === "shell" && typeof data.command === "string" && commands.length < MAX_COMMANDS) {
      const status = data.status
      if (status === "complete" || status === "error" || status === "cancelled" || status === "timeout") {
        commands.push({ rule: commandRule(data.command) ?? "(compound)", status,
          exitCode: typeof data.exitCode === "number" ? data.exitCode : null, durationMs: typeof data.durationMs === "number" ? data.durationMs : 0 })
      }
    }
    if ((record.kind === "workflow-stage" || record.kind === "workflow-choice") && typeof data.workflowID === "string" && workflows.size < MAX_WORKFLOWS) {
      const stage = typeof data.stage === "string" ? data.stage : typeof data.phase === "string" ? data.phase : record.kind
      workflows.set(data.workflowID, stage.slice(0, 64))
    }
  }
  const routes: SessionDigest["routes"] = {}
  for (const [role, route] of Object.entries(metadata?.routes ?? {})) if (route) routes[role] = { engine: route.engine, model: route.model }
  return {
    schemaVersion: DIGEST_SCHEMA_VERSION, kind: "session-digest", sessionID,
    engine: metadata?.engine ?? "unknown", model: metadata?.model ?? null, routes,
    startedAt: metadata?.createdAt ?? null, endedAt, turns, tools, decisions,
    files: [...files].sort(), commands, workflows: [...workflows].map(([id, stage]) => ({ id, stage })).sort((a, b) => a.id.localeCompare(b.id)),
    outcome: lastKind === "assistant" ? "completed" : "abandoned",
    complete,
  }
}

/** Write (or replace) the digest of a session; a session with no user turn leaves none. Returns the digest written. */
export function writeSessionDigest(worktree: string, sessionID: string, endedAt = Date.now()): SessionDigest | undefined {
  const digest = buildSessionDigest(worktree, sessionID, endedAt)
  if (digest.turns === 0) return undefined
  const directory = digestDirectory(worktree)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = digestPath(worktree, sessionID)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(digest, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return digest
}

function validDigest(value: unknown): value is SessionDigest {
  if (!value || typeof value !== "object") return false
  const digest = value as Partial<SessionDigest>
  return digest.schemaVersion === 1 && digest.kind === "session-digest" && typeof digest.sessionID === "string" &&
    typeof digest.endedAt === "number" && typeof digest.turns === "number" && Array.isArray(digest.commands) && Array.isArray(digest.files)
}

/** Digests of this worktree, newest first; unreadable or foreign files are skipped. */
export function readSessionDigests(worktree: string, limit = MAX_DIGESTS_READ): SessionDigest[] {
  let names: string[]
  try { names = readdirSync(digestDirectory(worktree)).filter(name => name.endsWith(".json")) } catch { return [] }
  const digests: SessionDigest[] = []
  for (const name of names) {
    const path = join(digestDirectory(worktree), name)
    try {
      if (!lstatSync(path).isFile()) continue
      const value: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (validDigest(value)) digests.push(value)
    } catch { /* skip */ }
  }
  return digests.sort((a, b) => b.endedAt - a.endedAt || b.sessionID.localeCompare(a.sessionID)).slice(0, Math.max(0, limit))
}

export function readSessionDigest(worktree: string, sessionID: string): SessionDigest | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(digestPath(worktree, sessionID), "utf8"))
    return validDigest(value) ? value : undefined
  } catch { return undefined }
}

/** One line for `/history`. */
export function describeDigest(digest: SessionDigest): string {
  const when = new Date(digest.endedAt).toISOString().replace("T", " ").slice(0, 16)
  const runs = digest.commands.length
  const failedRuns = digest.commands.filter(command => command.status !== "complete").length
  const model = digest.model ? `${digest.engine}/${digest.model}` : digest.engine
  return `${when} · ${model} · ${digest.turns} turn${digest.turns === 1 ? "" : "s"} · ${digest.files.length} file${digest.files.length === 1 ? "" : "s"} · ${runs} command${runs === 1 ? "" : "s"}${failedRuns ? ` (${failedRuns} failed)` : ""} · ${digest.outcome}`
}
