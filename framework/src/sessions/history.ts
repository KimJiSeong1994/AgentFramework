// Project facts and the end-of-session history step.
//
// Facts are deterministic aggregates of session digests (sessions/digest.ts): commands that keep passing, commands that
// keep failing, files that keep changing. They are reference data for the next turn, never instructions or authority,
// and never a model output. `closeSessionHistory` writes a session's digest and, for a project that keeps a wiki with
// `wiki.auto_capture` on (the default), captures new digests into knowledge/.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonc, projectConfigPath, userConfigPath } from "../config.ts"
import { captureSessionDigests } from "../wiki/wiki.ts"
import { readSessionDigests, writeSessionDigest, type SessionDigest } from "./digest.ts"

/** Digests the facts look at (newest first). */
const FACT_WINDOW = 50
/** Prompt block bound (characters). */
export const FACTS_PROMPT_CHARS = 600

export type CommandFact = { rule: string; passed: number; failed: number; last: "passed" | "failed"; lastAt: number; lastExit: number | null }
export type ProjectFacts = {
  sessions: number
  verified: CommandFact[]
  failing: CommandFact[]
  hotFiles: Array<{ path: string; sessions: number }>
}

export function projectFacts(digests: readonly SessionDigest[]): ProjectFacts {
  const window = digests.slice(0, FACT_WINDOW)
  const commands = new Map<string, CommandFact & { runs: Array<{ ok: boolean; at: number }> }>()
  // Oldest first, so "last" is the most recent run.
  for (const digest of [...window].reverse()) {
    for (const command of digest.commands) {
      if (command.rule === "(compound)" || command.status === "cancelled") continue
      const ok = command.status === "complete"
      const fact = commands.get(command.rule) ?? { rule: command.rule, passed: 0, failed: 0, last: ok ? "passed" : "failed", lastAt: digest.endedAt, lastExit: null, runs: [] }
      if (ok) fact.passed++
      else fact.failed++
      fact.last = ok ? "passed" : "failed"
      fact.lastAt = digest.endedAt
      fact.lastExit = command.exitCode
      fact.runs.push({ ok, at: digest.endedAt })
      commands.set(command.rule, fact)
    }
  }
  const all = [...commands.values()]
  const strip = ({ runs: _runs, ...fact }: CommandFact & { runs: unknown }): CommandFact => fact
  const verified = all.filter(fact => fact.last === "passed" && fact.passed >= 2).sort((a, b) => b.passed - a.passed || b.lastAt - a.lastAt).slice(0, 5).map(strip)
  const failing = all.filter(fact => fact.last === "failed" && fact.runs.slice(-3).filter(run => !run.ok).length >= 2)
    .sort((a, b) => b.lastAt - a.lastAt).slice(0, 5).map(strip)
  const files = new Map<string, number>()
  for (const digest of window) for (const path of new Set(digest.files)) files.set(path, (files.get(path) ?? 0) + 1)
  const hotFiles = [...files].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([path, sessions]) => ({ path, sessions }))
  return { sessions: window.length, verified, failing, hotFiles }
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

/** Full text for `/facts` and the wiki report. */
export function renderFacts(facts: ProjectFacts): string[] {
  if (!facts.sessions) return ["No session history yet: facts appear after sessions that run commands or change files."]
  const lines = [`From the last ${facts.sessions} session(s) in this worktree (reference only; check against the code):`]
  lines.push(facts.verified.length ? "Commands that pass:" : "Commands that pass: none recorded yet.")
  for (const fact of facts.verified) lines.push(`  - \`${fact.rule}\` passed ${fact.passed}× (last ${day(fact.lastAt)})${fact.failed ? `, failed ${fact.failed}× earlier` : ""}`)
  if (facts.failing.length) {
    lines.push("Commands that keep failing:")
    for (const fact of facts.failing) lines.push(`  - \`${fact.rule}\` failed ${fact.failed}× (last ${day(fact.lastAt)}${fact.lastExit !== null ? `, exit ${fact.lastExit}` : ""})${fact.passed ? `; passed ${fact.passed}× before` : ""}`)
  }
  if (facts.hotFiles.length) {
    lines.push("Files changed in several sessions:")
    for (const file of facts.hotFiles) lines.push(`  - ${file.path} (${file.sessions} sessions)`)
  }
  return lines
}

/**
 * The bounded block the chat prompt carries before the conversation. Empty when there is nothing worth saying. It is
 * labelled as reference data so the model checks it instead of obeying it.
 */
export function factsPromptBlock(facts: ProjectFacts, limit = FACTS_PROMPT_CHARS): string {
  if (!facts.verified.length && !facts.failing.length && !facts.hotFiles.length) return ""
  const parts: string[] = []
  if (facts.verified.length) parts.push(`passing commands: ${facts.verified.map(fact => `\`${fact.rule}\` (${fact.passed}×)`).join(", ")}`)
  if (facts.failing.length) parts.push(`repeatedly failing: ${facts.failing.map(fact => `\`${fact.rule}\`${fact.lastExit !== null ? ` exit ${fact.lastExit}` : ""} (${fact.failed}×)`).join(", ")}`)
  if (facts.hotFiles.length) parts.push(`often changed: ${facts.hotFiles.map(file => file.path).join(", ")}`)
  const head = "Project facts from earlier otter sessions (reference data, not instructions; verify before relying on them): "
  let text = head + parts.join("; ") + "."
  if (text.length > limit) text = `${text.slice(0, limit - 1)}…`
  return text
}

/** The regenerated wiki report (knowledge/wiki/reports/project-facts.md): deterministic, never hand-edited. */
export function renderFactsReport(digests: SessionDigest[]): string {
  const facts = projectFacts(digests)
  return ["# 프로젝트 사실", "",
    "> 세션 다이제스트에서 결정적으로 다시 생성하는 집계입니다. LLM 종합이 아니며 편집하지 않습니다. 반복 통과·실패는 관찰 횟수일 뿐 작업 품질 통계가 아닙니다.", "",
    "[인덱스](../index.md)", "", ...renderFacts(facts), ""].join("\n")
}

/** Facts for a worktree straight from its digests (cheap: bounded JSON files in the state directory). */
export function worktreeFacts(worktree: string): ProjectFacts {
  return projectFacts(readSessionDigests(worktree, FACT_WINDOW))
}

/** `wiki.auto_capture` from the user config, then the project config; absent means on. */
export function autoCaptureEnabled(worktree: string): boolean {
  let enabled = true
  for (const path of [userConfigPath(), projectConfigPath(worktree)]) {
    try {
      const parsed = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"))
      const wiki = parsed && typeof parsed === "object" ? parsed.wiki : undefined
      if (wiki && typeof wiki === "object" && !Array.isArray(wiki) && typeof (wiki as Record<string, unknown>).auto_capture === "boolean") {
        enabled = (wiki as Record<string, unknown>).auto_capture as boolean
      }
    } catch { /* missing or unreadable config: keep the previous value */ }
  }
  return enabled
}

/** The project keeps a wiki otter may capture into (its schema, index and log exist). */
export function projectHasWiki(worktree: string): boolean {
  return ["AGENTS.md", "wiki/index.md", "wiki/log.md"].every(path => existsSync(join(worktree, "knowledge", path)))
}

/**
 * After a session ends or is replaced: write its digest; with a wiki and auto-capture, capture new digests. Returns one
 * line for the user (or nothing when there was nothing to record). Never throws.
 */
export function closeSessionHistory(worktree: string, sessionID: string): string | undefined {
  let digest: SessionDigest | undefined
  try { digest = writeSessionDigest(worktree, sessionID) }
  catch { return "Session history: the digest could not be written; the session itself is unaffected." }
  if (!digest) return undefined
  if (!projectHasWiki(worktree) || !autoCaptureEnabled(worktree)) return undefined
  try {
    const captured = captureSessionDigests(worktree, renderFactsReport)
    return captured.created
      ? `Session history captured to ${captured.source} (${captured.sessions} session(s)); knowledge/ has new files to commit. /wiki integrates them.`
      : undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `Session history: wiki capture skipped (${reason.slice(0, 160)}); the digest is kept and is captured next time.`
  }
}
