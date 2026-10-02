import { createHash, randomUUID } from "node:crypto"
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { containsSecret } from "../security/secrets.ts"
import { listToolOutcomes, type ToolOutcome } from "../telemetry/outcomes.ts"
import { isRoutingSnapshot, readRoutingLogs, type RoutingEvent, type RoutingSnapshot } from "../telemetry/routing-reader.ts"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const markdown = (text: string) => text.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
/** Inverse of markdown(): our own escaping only ever inserts a single backslash before a matched char. */
const unescapeMarkdown = (text: string) => text.replace(/\\([\\`*_[\]{}()<>#+.!|~-])/g, "$1")

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
}
function safeDirectory(root: string, segments: string[]): string {
  let path = root
  for (const segment of segments) {
    path = join(path, segment)
    // Concurrent writers may create the same directory; EEXIST is fine as long as the result is a real directory.
    try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Wiki directory must not be a symlink or file")
  }
  return path
}
function safeFile(path: string) {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Wiki file must be a regular file")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
function replaceDerived(path: string, text: string) {
  safeFile(path)
  if (existsSync(path) && readFileSync(path, "utf8") === text) return
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let created = false
  try { writeFileSync(temp, text, { flag: "wx", mode: 0o600 }); created = true; renameSync(temp, path) }
  finally { if (created && existsSync(temp)) unlinkSync(temp) }
}
function createOnly(path: string, text: string): boolean {
  safeFile(path)
  if (existsSync(path)) return false
  writeFileSync(path, text, { flag: "wx", mode: 0o600 })
  return true
}

// -- Shared lock ------------------------------------------------------------------------------------------------
// Single lock file for the whole knowledge/ tree: capture and register both hold it while writing; lint and
// status only observe it (never remove a lock they did not create).
function lockPath(root: string): string {
  return join(root, "knowledge", ".wiki.lock")
}
/** Owner pid of a lock whose recorded process is no longer running; null if live, unreadable or foreign-host unknown. */
export function staleLockPid(root: string): number | null {
  let pid: unknown
  try { pid = JSON.parse(readFileSync(lockPath(root), "utf8")).pid } catch { return null }
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null
  try { process.kill(pid as number, 0); return null } catch (error) {
    // EPERM: the process exists but belongs to another user, so it is alive.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? pid as number : null
  }
}

function lockProblem(root: string): string {
  const stale = staleLockPid(root)
  return stale === null
    ? "Wiki lock exists; verify the owning process before retrying"
    : `Stale wiki lock from exited process ${stale}; run \`bun scripts/lca-wiki.ts unlock\``
}

/**
 * Creates the lock (wx, 0600) or throws a refusal error. Writers never remove a lock they did not create, so a
 * lock is only ever deleted by its owner or by an explicit `unlock` of a dead owner's lock.
 */
function acquireLock(root: string): string {
  const knowledge = safeDirectory(root, ["knowledge"])
  const lock = join(knowledge, ".wiki.lock")
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(lockProblem(root))
    throw error
  }
  return lock
}

export type UnlockReceipt = { removed: boolean; pid: number | null }

/**
 * Explicit recovery after a crash: removes the lock only when its recorded pid has exited and the file still has
 * the exact content that was judged stale. A live, unreadable or foreign lock is refused and left in place.
 */
export function unlockWiki(worktree: string): UnlockReceipt {
  const root = realpathSync(worktree)
  const lock = lockPath(root)
  let before: string
  try { before = readFileSync(lock, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: false, pid: null }
    throw error
  }
  const stale = staleLockPid(root)
  if (stale === null) throw new Error("Wiki lock is held by a live or unidentifiable process; refusing to remove it")
  if (readFileSync(lock, "utf8") !== before) throw new Error("Wiki lock changed while checking; retry")
  unlinkSync(lock)
  return { removed: true, pid: stale }
}

// -- Log grammar --------------------------------------------------------------------------------------------------
const LOG_HEADING = /^## \[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\] (capture|register|ingest|query|lint) \| (.+)$/

export type LogEntry = { at: string; op: string; title: string; body: string }

/** Parses well-formed `## [ISO] op | title` headings and their body text; malformed/unknown headings are not entries (lint flags them separately). */
export function parseLog(text: string): LogEntry[] {
  const lines = text.split(/\r\n|\n/)
  const entries: LogEntry[] = []
  let current: LogEntry | null = null
  let bodyLines: string[] = []
  for (const line of lines) {
    const match = LOG_HEADING.exec(line)
    if (match) {
      if (current) { current.body = bodyLines.join("\n").trim(); entries.push(current) }
      current = { at: match[1]!, op: match[2]!, title: match[3]!, body: "" }
      bodyLines = []
    } else if (current) bodyLines.push(line)
  }
  if (current) { current.body = bodyLines.join("\n").trim(); entries.push(current) }
  return entries
}
function hasSourceId(entry: LogEntry, id: string): boolean {
  return entry.body.split("\n").some((line) => line.trim() === `- source_id: ${id}`)
}

export function summarizeOutcomes(rows: ToolOutcome[]) {
  const calls = new Map<string, ToolOutcome[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.sessionID, row.callID])
    const observations = calls.get(key) ?? []
    if (!observations.some((old) => old.id === row.id)) observations.push(row)
    calls.set(key, observations)
  }
  const tools = new Map<string, { tool: string; success: number; failure: number; unknown: number; durations: number[] }>()
  let conflicts = 0
  for (const observations of calls.values()) {
    const names = new Set(observations.map((r) => r.tool))
    const statuses = new Set(observations.map((r) => r.status))
    const conflicting = names.size > 1 || statuses.size > 1
    if (conflicting) conflicts++
    const latest = observations.reduce((a, b) => a.recordedAt >= b.recordedAt ? a : b)
    const tool = names.size > 1 ? "conflicting-tool-identity" : latest.tool
    const status = conflicting ? "unknown" : latest.status
    const tally = tools.get(tool) ?? { tool, success: 0, failure: 0, unknown: 0, durations: [] }
    tally[status]++
    if (!conflicting && latest.durationMs !== null) tally.durations.push(latest.durationMs)
    tools.set(tool, tally)
  }
  return { calls: calls.size, observations: rows.length, conflicts, tools: [...tools.values()].sort((a, b) => a.tool.localeCompare(b.tool)) }
}

function renderReport(rows: ToolOutcome[], totalCount: number, sourceName: string): string {
  const summary = summarizeOutcomes(rows)
  const lines = ["# 도구 실행 결과 — 관측 집계", "", "> 코드로 생성한 보고서입니다. 원인 분석이나 LLM의 의미적 검증 결과가 아닙니다.", "",
    `[위키 인덱스](../index.md) · [불변 원본](../../raw/tool-runs/${sourceName}.json)`, "",
    `- 포함된 관측: ${rows.length} / 전체 저장 관측: ${totalCount}`,
    `- 포함된 고유 호출: ${summary.calls}; 상충하는 호출 결과: ${summary.conflicts}`,
    "- success는 도구가 완료됐다는 관측이며, 작업의 정확성이나 사용자 목표 달성을 보장하지 않습니다.",
    "- 같은 호출의 서로 다른 결과는 unknown으로 집계합니다. 오류 원문·인자·출력은 저장하지 않습니다.",
    "- 이 보고서는 최신 스냅샷 범위만 집계합니다. 장기 분석은 원본 id를 기준으로 여러 스냅샷을 중복 제거해야 합니다.", "",
    "| 도구 | 성공 | 실패 | 미확정 | 관측 duration 중앙값(ms) |",
    "|---|---:|---:|---:|---:|"]
  for (const tool of summary.tools) {
    const sorted = tool.durations.sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length ? (sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2) : null
    lines.push(`| ${markdown(tool.tool)} | ${tool.success} | ${tool.failure} | ${tool.unknown} | ${median === null ? "미측정" : median} |`)
  }
  if (!rows.length) lines.push("", "아직 기록된 도구 실행이 없습니다. 과거 대화나 테스트 결과를 실제 실행 기록으로 채워 넣지 않았습니다.")
  if (rows.length < totalCount) lines.push("", "주의: 내보내기 한도 때문에 일부 관측이 포함되지 않았습니다. 이 표는 전체 사용 이력이 아닙니다.")
  return lines.join("\n") + "\n"
}

type RoutingDecisionEvent = Extract<RoutingEvent, { event: "decision" }>

function summarizeRouting(snapshot: RoutingSnapshot) {
  const decisions = snapshot.events.filter((event): event is RoutingDecisionEvent => event.event === "decision")
  const applications = snapshot.events.filter((event): event is Extract<RoutingEvent, { event: "advice_applied" }> => event.event === "advice_applied")
  const decisionsById = new Map<string, RoutingDecisionEvent[]>()
  for (const decision of decisions) {
    const rows = decisionsById.get(decision.decisionID) ?? []
    rows.push(decision)
    decisionsById.set(decision.decisionID, rows)
  }
  let matchedApplications = 0
  let unmatchedApplications = 0
  let conflictingApplications = 0
  for (const application of applications) {
    const matches = decisionsById.get(application.decisionID) ?? []
    if (matches.length === 0) { unmatchedApplications++; continue }
    if (matches.length !== 1) { conflictingApplications++; continue }
    const [decision] = matches
    if (decision!.mode === "suggest" && decision!.reason === "recommended" && decision!.skill === application.skill
      && decision!.sessionID === application.sessionID && decision!.messageID === application.messageID) matchedApplications++
    else conflictingApplications++
  }
  const modes = new Map<string, number>()
  const reasons = new Map<string, number>()
  for (const decision of decisions) {
    modes.set(decision.mode, (modes.get(decision.mode) ?? 0) + 1)
    reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + 1)
  }
  const rejected = new Map<string, number>()
  for (const item of snapshot.rejected) rejected.set(item.reason, (rejected.get(item.reason) ?? 0) + 1)
  return { decisions, applications, matchedApplications, unmatchedApplications, conflictingApplications, modes, reasons, rejected }
}

function renderRoutingReport(snapshot: RoutingSnapshot, sourceName: string): string {
  const summary = summarizeRouting(snapshot)
  const coverage = snapshot.coverage
  const lines = [
    "# Jev routing observations",
    "",
    "> Deterministic, sanitized routing telemetry. Recommendations and advice insertion are not evidence of skill execution, task success, calibration, or causality.",
    "",
    `[Wiki index](../index.md) · [Immutable snapshot](../../raw/routing/${sourceName}.json)`,
    "",
    `- Scan scope: ${coverage.scope}; files scanned: ${coverage.filesScanned}; event records scanned: ${coverage.scanned}. No unscanned total is inferred.`,
    `- Unique valid events: ${coverage.valid}; rejected event records: ${coverage.invalid}; identical event replays: ${coverage.duplicates}; rejected filenames: ${coverage.invalidFiles}.`,
    `- Truncated: ${coverage.truncated ? `yes (${coverage.truncationReasons.join(", ")})` : "no"}.`,
    `- Decisions: ${summary.decisions.length}; advice-applied events: ${summary.applications.length}; exactly matched suggest recommendations: ${summary.matchedApplications}; unmatched applications: ${summary.unmatchedApplications}; conflicting or ineligible applications: ${summary.conflictingApplications}.`,
    "- A matched advice-applied event records insertion of advice only; it does not establish that a skill ran or that its work succeeded.",
    "- Unmatched means no decision was found within this snapshot; conflicting includes mismatched session/message/skill or an ineligible decision.",
    "",
    "## Decisions by mode",
    "",
    "| Mode | Decisions |",
    "|---|---:|",
  ]
  for (const [mode, count] of [...summary.modes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) lines.push(`| ${mode} | ${count} |`)
  lines.push("", "## Decisions by reason", "", "| Reason | Decisions |", "|---|---:|")
  for (const [reason, count] of [...summary.reasons].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) lines.push(`| ${reason} | ${count} |`)
  lines.push("", "## Rejected input", "", "| Rejection reason | Count |", "|---|---:|")
  for (const [reason, count] of [...summary.rejected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) lines.push(`| ${reason} | ${count} |`)
  if (!snapshot.events.length && coverage.scanned === 0 && coverage.invalidFiles === 0 && !coverage.truncated) {
    lines.push("", "No routing observations were found. This is explicit zero-observation evidence; no decisions or applications were synthesized.")
  }
  if (coverage.truncated) lines.push("", "This snapshot covers only the bounded scan shown above; additional routing input may exist outside the scanned scope.")
  return lines.join("\n") + "\n"
}

function routingSourcePage(snapshot: RoutingSnapshot, sourceId: string): string {
  const summary = summarizeRouting(snapshot)
  const coverage = snapshot.coverage
  return [
    "# Jev routing observations",
    "",
    "> Sanitized, content-addressed capture of routing decisions and advice-insertion observations. This is not a skill execution, success, calibration, or causal record.",
    "",
    `[Immutable snapshot](../../raw/routing/${sourceId}.json) · [Index](../index.md) · [Routing report](../reports/routing.md)`,
    "",
    `- source_id: ${sourceId}`,
    `- Unique valid events: ${coverage.valid}; decisions: ${summary.decisions.length}; advice-applied events: ${summary.applications.length}.`,
    `- Rejected records: ${coverage.invalid}; duplicate replays: ${coverage.duplicates}; bounded scope: ${coverage.scope}.`,
    "- Original text, error bodies, and unrecognized metadata are not exported.",
    "",
    "## Interpretation",
    "",
    "A recommendation is a routing observation, not a claim that a skill executed. Advice-applied events are paired only when decision ID, session, message, skill, and a recommended suggest-mode decision all agree. Other applications remain unmatched or conflicting in the report.",
    "",
  ].join("\n")
}

/** Deterministic capture is not semantic ingestion: the coding agent maintains synthesis pages separately. */
export function captureWiki(worktree: string) {
  const root = realpathSync(worktree)
  // Validate and bound untrusted routing input before the lock or any wiki output is written.
  const routingSnapshot = readRoutingLogs(root)
  const lock = acquireLock(root)
  try {
    const raw = safeDirectory(root, ["knowledge", "raw", "tool-runs"])
    const routingRaw = safeDirectory(root, ["knowledge", "raw", "routing"])
    const wiki = safeDirectory(root, ["knowledge", "wiki"])
    const sources = safeDirectory(root, ["knowledge", "wiki", "sources"])
    const reports = safeDirectory(root, ["knowledge", "wiki", "reports"])
    const index = join(wiki, "index.md")
    const log = join(wiki, "log.md")
    safeFile(index); safeFile(log)
    if (!existsSync(index) || !existsSync(log) || !existsSync(join(root, "knowledge", "AGENTS.md"))) throw new Error("Wiki schema, index and log must exist before capture")
    const { rows, totalCount } = listToolOutcomes(root)
    // Explicit projection keeps raw exports narrow even if the database schema grows later.
    const observations = rows.map((r) => ({ schemaVersion: r.schemaVersion, id: r.id, sessionID: r.sessionID, callID: r.callID,
      tool: r.tool, status: r.status, basis: r.basis, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, recordedAt: r.recordedAt }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const content = JSON.stringify({ schemaVersion: 1, kind: "tool-outcome-snapshot", coverage: { totalCount, included: observations.length, limit: 10000 }, observations }, null, 2) + "\n"
    const sourceName = digest(content)
    const rawPath = join(raw, `${sourceName}.json`)
    const created = createOnly(rawPath, content)
    if (!created && readFileSync(rawPath, "utf8") !== content) throw new Error("Immutable raw source hash mismatch; refusing overwrite")
    const sourcePage = `tool-runs-${sourceName}.md`
    createOnly(join(sources, sourcePage), ["# 도구 실행 관측 원본", "", "> 최초 요약은 결정적 집계입니다. 에이전트는 원본을 읽고 출처를 유지하면서 이 페이지를 확장할 수 있습니다.", "",
      `[불변 원본](../../raw/tool-runs/${sourceName}.json) · [인덱스](../index.md) · [관측 집계](../reports/tool-outcomes.md)`, "",
      `- source_id: ${sourceName}`, `- 포함 관측: ${observations.length} / 전체 관측: ${totalCount}`,
      "- 근거 범위: 도구가 보고한 완료/오류 및 명시적 종료 코드. 업무 정확성이나 실패의 근본 원인은 이 자료만으로 판단하지 않습니다.", "",
      "## 지식 통합", "", "LLM이 ingest할 때 기존 도구·개념 페이지와 비교하고, 새로 확인된 사실과 기존 주장과의 충돌을 출처 링크와 함께 기록합니다. 확인할 수 없는 원인은 미확정으로 남깁니다.", ""].join("\n"))
    replaceDerived(join(reports, "tool-outcomes.md"), renderReport(observations, totalCount, sourceName))
    const indexLink = `sources/${sourcePage}`
    const indexText = readFileSync(index, "utf8")
    if (!indexText.includes(`](${indexLink})`)) replaceDerived(index, `${indexText.trimEnd()}\n\n- [도구 실행 원본 ${sourceName.slice(0, 12)}](${indexLink}) — ${observations.length}개 관측; 전체 ${totalCount}개 중 포함된 범위.\n`)
    const logText = readFileSync(log, "utf8")
    const alreadyLogged = parseLog(logText).some((e) => e.op === "capture" && hasSourceId(e, sourceName))
    if (!alreadyLogged) {
      // Append, never regenerate: LLM ingest/query/lint entries must survive future captures.
      writeFileSync(log, `\n## [${new Date().toISOString()}] capture | 도구 실행 관측\n\n- source_id: ${sourceName}\n- [원본 요약](sources/${sourcePage}); ${observations.length}/${totalCount}개 관측.\n- 의미적 ingest는 아직 실행하지 않았습니다.\n`, { flag: "a", mode: 0o600 })
    }

    const routingContent = JSON.stringify(routingSnapshot, null, 2) + "\n"
    const routingSourceId = digest(routingContent)
    const routingRawPath = join(routingRaw, `${routingSourceId}.json`)
    const routingCreated = createOnly(routingRawPath, routingContent)
    if (!routingCreated && readFileSync(routingRawPath, "utf8") !== routingContent) throw new Error("Immutable raw routing source hash mismatch; refusing overwrite")
    const routingPageName = `routing-${routingSourceId}.md`
    const routingPagePath = join(sources, routingPageName)
    createOnly(routingPagePath, routingSourcePage(routingSnapshot, routingSourceId))
    replaceDerived(join(reports, "routing.md"), renderRoutingReport(routingSnapshot, routingSourceId))

    const currentIndex = readFileSync(index, "utf8")
    let nextIndex = currentIndex.trimEnd()
    if (!currentIndex.includes(`](sources/${routingPageName})`)) {
      nextIndex += `\n\n- [Jev routing snapshot ${routingSourceId.slice(0, 12)}](sources/${routingPageName}) — ${routingSnapshot.coverage.valid}개 유효 이벤트; ${routingSnapshot.coverage.scope} 범위.`
    }
    if (!currentIndex.includes("](reports/routing.md)")) nextIndex += "\n- [Jev routing report](reports/routing.md)"
    if (nextIndex !== currentIndex.trimEnd()) replaceDerived(index, `${nextIndex}\n`)

    const currentLog = readFileSync(log, "utf8")
    const routingLogged = parseLog(currentLog).some((entry) => entry.op === "capture" && hasSourceId(entry, routingSourceId))
    if (!routingLogged) {
      writeFileSync(log, `\n## [${new Date().toISOString()}] capture | Jev routing observations\n\n- source_id: ${routingSourceId}\n- [Sanitized routing snapshot](sources/${routingPageName}); ${routingSnapshot.coverage.valid} unique valid events.\n- Recommendations and advice insertion are not evidence of skill execution or success.\n`, { flag: "a", mode: 0o600 })
    }
    const routingSummary = summarizeRouting(routingSnapshot)
    return {
      source: relative(root, rawPath), summary: relative(root, join(sources, sourcePage)),
      report: relative(root, join(reports, "tool-outcomes.md")), created, observations: observations.length, totalCount,
      routing: {
        source: relative(root, routingRawPath), summary: relative(root, routingPagePath),
        report: relative(root, join(reports, "routing.md")), created: routingCreated,
        events: routingSnapshot.coverage.valid, decisions: routingSummary.decisions.length,
        adviceApplied: routingSummary.applications.length, coverage: routingSnapshot.coverage,
      },
    }
  } finally { unlinkSync(lock) }
}

// -- Register -----------------------------------------------------------------------------------------------------
const DOCUMENT_EXTS = [".md", ".txt"]
const MAX_REGISTER_BYTES = 131072
const MAX_TITLE_LENGTH = 120

function firstHeading(text: string): string | undefined {
  for (const line of text.split(/\r\n|\n/)) {
    const match = /^# (.+)$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

function storedRegisterTitle(root: string, id: string): string | undefined {
  const logPath = join(root, "knowledge", "wiki", "log.md")
  if (!existsSync(logPath)) return undefined
  const entry = parseLog(readFileSync(logPath, "utf8")).find((e) => e.op === "register" && hasSourceId(e, id))
  return entry ? unescapeMarkdown(entry.title) : undefined
}

function sourcePageText(title: string, id: string, ext: string, bytesLen: number, fileBaseName: string): string {
  return [
    `# ${markdown(title)}`,
    "",
    "> 이 페이지는 등록 시점에 결정적으로 생성되었습니다. 에이전트는 원본을 읽고 출처를 유지하면서 이 페이지를 확장할 수 있습니다.",
    "",
    `[불변 원본](../../raw/documents/${id}${ext}) · [인덱스](../index.md)`,
    "",
    `- source_id: ${id}`,
    `- 형식: ${ext.slice(1)}; 바이트: ${bytesLen}`,
    `- 원본 파일명: ${markdown(fileBaseName)}`,
    "",
    "## 지식 통합",
    "",
    "LLM이 ingest할 때 기존 위키 페이지와 비교하고, 새로 확인된 사실과 기존 주장과의 충돌을 출처 링크와 함께 기록합니다. 확인할 수 없는 내용은 미확정으로 남깁니다.",
    "",
  ].join("\n")
}

export type RegisterReceipt = { sourceId: string; kind: "documents"; source: string; summary: string; title: string; bytes: number; created: boolean }

/** Registers an immutable local document as a wiki raw source. Compile/ingest into synthesis pages stays an LLM procedure. */
export function registerWiki(worktree: string, file: string, opts: { title?: string } = {}): RegisterReceipt {
  const root = realpathSync(worktree)
  const requestedPath = resolve(file)
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(requestedPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") throw new Error("Register source file does not exist")
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Register source must be a regular, non-symlink file")
  const realFile = realpathSync(requestedPath)
  if (contained(join(root, "knowledge"), realFile)) throw new Error("Register source must not already be inside knowledge/")
  const ext = extname(realFile).toLowerCase()
  if (!DOCUMENT_EXTS.includes(ext)) throw new Error("Register source extension must be .md or .txt")
  const bytes = readFileSync(realFile)
  if (bytes.length === 0 || bytes.length > MAX_REGISTER_BYTES) throw new Error(`Register source size must be between 1 and ${MAX_REGISTER_BYTES} bytes`)
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { throw new Error("Register source must be valid UTF-8") }
  if (bytes.includes(0)) throw new Error("Register source must not contain NUL bytes")
  if (containsSecret(text)) throw new Error("Register source appears to contain a secret")
  const fileBaseName = basename(realFile)
  const candidateTitle = (opts.title ?? (ext === ".md" ? firstHeading(text) : undefined) ?? fileBaseName.slice(0, fileBaseName.length - ext.length)).trim()
  if (!candidateTitle || /[\x00-\x1f\x7f]/.test(candidateTitle) || candidateTitle.length > MAX_TITLE_LENGTH) throw new Error(`Register title must be non-empty, without control characters, and at most ${MAX_TITLE_LENGTH} characters`)
  if (containsSecret(candidateTitle)) throw new Error("Register title appears to contain a secret")
  const knowledge = join(root, "knowledge")
  for (const required of [join(knowledge, "AGENTS.md"), join(knowledge, "wiki", "index.md"), join(knowledge, "wiki", "log.md")]) {
    if (!existsSync(required)) throw new Error("Wiki schema, index and log must exist before register")
  }
  const lock = acquireLock(root)
  try {
    // Validate every file this call appends/replaces before the first write, so a refusal leaves no partial source.
    const indexPath = join(knowledge, "wiki", "index.md")
    const logPath = join(knowledge, "wiki", "log.md")
    safeFile(indexPath)
    safeFile(logPath)
    const rawDir = safeDirectory(root, ["knowledge", "raw", "documents"])
    const id = digestBytes(bytes)
    const rawPath = join(rawDir, `${id}${ext}`)
    safeFile(rawPath)
    // One id per content: the same bytes under the other allowed extension would split status/pages by format.
    for (const other of DOCUMENT_EXTS) {
      if (other !== ext && existsSync(join(rawDir, `${id}${other}`))) throw new Error(`Identical content is already registered as ${other}`)
    }
    let created = false
    if (existsSync(rawPath)) {
      const existing = readFileSync(rawPath)
      if (!existing.equals(bytes)) throw new Error("Immutable raw source hash mismatch")
    } else {
      writeFileSync(rawPath, bytes, { flag: "wx", mode: 0o600 })
      created = true
    }
    const effectiveTitle = created ? candidateTitle : storedRegisterTitle(root, id) ?? candidateTitle
    const sourcesDir = safeDirectory(root, ["knowledge", "wiki", "sources"])
    const sourcePageName = `documents-${id}.md`
    const sourcePagePath = join(sourcesDir, sourcePageName)
    createOnly(sourcePagePath, sourcePageText(effectiveTitle, id, ext, bytes.length, fileBaseName))
    const indexLink = `sources/${sourcePageName}`
    const indexText = readFileSync(indexPath, "utf8")
    if (!indexText.includes(`](${indexLink})`)) replaceDerived(indexPath, `${indexText.trimEnd()}\n\n- [${markdown(effectiveTitle)}](${indexLink}) — 등록 문서, ${bytes.length} bytes.\n`)
    const logText = readFileSync(logPath, "utf8")
    const alreadyLogged = parseLog(logText).some((e) => e.op === "register" && hasSourceId(e, id))
    if (!alreadyLogged) {
      writeFileSync(logPath, `\n## [${new Date().toISOString()}] register | ${markdown(effectiveTitle)}\n\n- source_id: ${id}\n- [원본 요약](sources/${sourcePageName}); 의미적 ingest는 아직 실행하지 않았습니다.\n`, { flag: "a", mode: 0o600 })
    }
    return { sourceId: id, kind: "documents", source: relative(root, rawPath), summary: relative(root, sourcePagePath), title: effectiveTitle, bytes: bytes.length, created }
  } finally { unlinkSync(lock) }
}

// -- Status ---------------------------------------------------------------------------------------------------------
export type PendingItem = { sourceId: string; kind: "documents" | "tool-runs" | "routing"; source: string; summary: string; title: string; registeredAt: string | null }
export type WikiStatus = { sources: number; compiled: number; pending: PendingItem[]; problems: string[]; locked?: true }

/** Read-only: never creates or modifies any wiki file. */
export function statusWiki(worktree: string): WikiStatus {
  const root = realpathSync(worktree)
  const knowledge = join(root, "knowledge")
  if (existsSync(lockPath(root))) return { sources: 0, compiled: 0, pending: [], problems: [lockProblem(root)], locked: true }
  const problems: string[] = []
  const wikiDir = join(knowledge, "wiki")
  const sourcesDir = join(wikiDir, "sources")
  const logPath = join(wikiDir, "log.md")
  const entries = existsSync(logPath) ? parseLog(readFileSync(logPath, "utf8")) : []
  type Item = PendingItem & { sourcePagePath: string }
  const items: Item[] = []
  for (const [dir, kind, pagePrefix] of [
    [join(knowledge, "raw", "documents"), "documents", "documents"],
    [join(knowledge, "raw", "tool-runs"), "tool-runs", "tool-runs"],
    [join(knowledge, "raw", "routing"), "routing", "routing"],
  ] as const) {
    if (kind === "routing") {
      let info: ReturnType<typeof lstatSync>
      try { info = lstatSync(dir) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
          problems.push("Routing raw source directory must be a real directory")
          continue
        }
        throw error
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        problems.push("Routing raw source directory must be a real directory")
        continue
      }
    } else if (!existsSync(dir)) continue
    for (const entryName of readdirSync(dir).sort()) {
      const full = join(dir, entryName)
      const info = lstatSync(full)
      if (kind === "routing" && (info.isSymbolicLink() || !info.isFile())) {
        problems.push(`Routing raw source is not a regular, non-symlink file: ${relative(root, full)}`)
        continue
      }
      if (info.isSymbolicLink() || !info.isFile()) continue
      const ext = extname(entryName)
      const id = entryName.slice(0, entryName.length - ext.length)
      const sourcePagePath = join(sourcesDir, `${pagePrefix}-${id}.md`)
      if (!existsSync(sourcePagePath)) { problems.push(`Raw source without source page: ${relative(root, full)}`); continue }
      const own = entries.find((e) => (e.op === "capture" || e.op === "register") && hasSourceId(e, id))
      if (!own) problems.push(`Raw source without capture/register log entry: ${relative(root, full)}`)
      const title = own ? unescapeMarkdown(own.title) : id
      items.push({ sourceId: id, kind, source: relative(root, full), summary: relative(root, sourcePagePath), title, registeredAt: own ? own.at : null, sourcePagePath })
    }
  }
  const compiledIds = new Set<string>()
  for (const entry of entries) {
    if (entry.op !== "ingest") continue
    for (const match of entry.body.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!
      if (/^https?:\/\//.test(link) || link.startsWith("#")) continue
      const target = resolve(wikiDir, link.split("#")[0]!)
      if (!contained(sourcesDir, target) && target !== sourcesDir) continue
      if (existsSync(target)) {
        const item = items.find((it) => it.sourcePagePath === target)
        if (item) compiledIds.add(item.sourceId)
      } else problems.push(`Ingest entry links unknown source: ${link}`)
    }
  }
  const pending = items.filter((it) => !compiledIds.has(it.sourceId))
    .map(({ sourcePagePath: _sourcePagePath, ...rest }) => rest)
    .sort((a, b) => {
      if (a.registeredAt === null && b.registeredAt === null) return a.sourceId.localeCompare(b.sourceId)
      if (a.registeredAt === null) return 1
      if (b.registeredAt === null) return -1
      const cmp = a.registeredAt.localeCompare(b.registeredAt)
      return cmp !== 0 ? cmp : a.sourceId.localeCompare(b.sourceId)
    })
  return { sources: items.length, compiled: compiledIds.size, pending, problems }
}

// -- Lint ------------------------------------------------------------------------------------------------------------
const RAW_DOCUMENT_EXT = new Set([".md", ".txt"])

/** Structural checks only; semantic contradictions/stale claims require the wiki-maintainer agent. */
export function lintWiki(worktree: string): string[] {
  const root = realpathSync(worktree)
  const knowledge = join(root, "knowledge")
  const problems: string[] = []
  if (existsSync(lockPath(root))) return [lockProblem(root)]
  const files: string[] = []
  function walk(path: string) {
    if (!existsSync(path)) return
    const info = lstatSync(path)
    if (info.isSymbolicLink()) { problems.push(`Symlink is not allowed in wiki evidence: ${relative(root, path)}`); return }
    if (info.isDirectory()) for (const entry of readdirSync(path).sort()) walk(join(path, entry))
    else if (info.isFile()) files.push(path)
  }
  walk(knowledge)
  for (const path of ["AGENTS.md", "wiki/index.md", "wiki/log.md", "wiki/reports/tool-outcomes.md"]) {
    if (!files.includes(join(knowledge, path))) problems.push(`Missing required wiki file: ${path}`)
  }
  const index = join(knowledge, "wiki", "index.md")
  const rawDir = join(knowledge, "raw")
  const toolRunsDir = join(rawDir, "tool-runs")
  const routingDir = join(rawDir, "routing")
  const documentsDir = join(rawDir, "documents")
  const sourcesDir = join(knowledge, "wiki", "sources")
  const indexed = new Set<string>()
  const knownRawIds = new Map<string, { kind: "documents" | "tool-runs" | "routing"; ext: string }>()
  for (const path of files) {
    const underRaw = contained(rawDir, path)
    if (path.endsWith(".md") && !underRaw) {
      const text = readFileSync(path, "utf8")
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1]!
        if (/^https?:\/\//.test(link) || /^mailto:/i.test(link) || link.startsWith("#")) continue
        if (/^[a-z]+:/i.test(link)) { problems.push(`Unsupported link scheme in ${relative(root, path)}`); continue }
        const target = resolve(dirname(path), link.split("#")[0]!)
        if (!contained(knowledge, target) || !files.includes(target)) problems.push(`Broken or unsafe link: ${relative(root, path)} -> ${link}`)
        else if (path === index) indexed.add(target)
      }
    } else if (underRaw && contained(toolRunsDir, path)) {
      if (extname(path) !== ".json") { problems.push(`Disallowed raw source extension: ${relative(root, path)}`); continue }
      const text = readFileSync(path, "utf8")
      const bytes = readFileSync(path)
      const id = digestBytes(bytes)
      if (path !== join(dirname(path), `${id}.json`)) problems.push(`Raw source integrity mismatch: ${relative(root, path)}`)
      else knownRawIds.set(id, { kind: "tool-runs", ext: ".json" })
      try {
        const data = JSON.parse(text)
        if (data.schemaVersion !== 1 || data.kind !== "tool-outcome-snapshot" || !Array.isArray(data.observations)) problems.push(`Invalid raw source schema: ${relative(root, path)}`)
      } catch { problems.push(`Invalid raw source JSON: ${relative(root, path)}`) }
    } else if (underRaw && contained(documentsDir, path)) {
      const ext = extname(path)
      if (!RAW_DOCUMENT_EXT.has(ext)) { problems.push(`Disallowed raw source extension: ${relative(root, path)}`); continue }
      const bytes = readFileSync(path)
      const id = digestBytes(bytes)
      if (path !== join(dirname(path), `${id}${ext}`)) problems.push(`Raw source integrity mismatch: ${relative(root, path)}`)
      else knownRawIds.set(id, { kind: "documents", ext })
    } else if (underRaw && contained(routingDir, path)) {
      if (extname(path) !== ".json") { problems.push(`Disallowed raw source extension: ${relative(root, path)}`); continue }
      const bytes = readFileSync(path)
      const id = digestBytes(bytes)
      if (path !== join(routingDir, `${id}.json`)) problems.push(`Raw source integrity mismatch: ${relative(root, path)}`)
      else knownRawIds.set(id, { kind: "routing", ext: ".json" })
      try {
        const data: unknown = JSON.parse(bytes.toString("utf8"))
        if (!isRoutingSnapshot(data)) problems.push(`Invalid routing snapshot schema or metadata: ${relative(root, path)}`)
      } catch { problems.push(`Invalid routing snapshot JSON: ${relative(root, path)}`) }
    } else if (underRaw) {
      problems.push(`Disallowed raw source extension: ${relative(root, path)}`)
    }
  }
  for (const path of files.filter((p) => p.startsWith(join(knowledge, "wiki") + "/") && p.endsWith(".md") && p !== index)) {
    if (!indexed.has(path)) problems.push(`Wiki page missing from index: ${relative(root, path)}`)
  }
  // Raw <-> source-page pairing, both directions.
  for (const [id, info] of knownRawIds) {
    const pagePath = join(sourcesDir, `${info.kind}-${id}.md`)
    if (!files.includes(pagePath)) problems.push(`Raw source without matching source page: ${info.kind}/${id}${info.ext}`)
  }
  const sourcePageRe = /^(documents|tool-runs|routing)-([0-9a-f]{64})\.md$/
  if (existsSync(sourcesDir)) {
    for (const entryName of readdirSync(sourcesDir).sort()) {
      const match = sourcePageRe.exec(entryName)
      if (!match) continue
      const [, kind, id] = match as unknown as [string, "documents" | "tool-runs" | "routing", string]
      const info = knownRawIds.get(id)
      if (!info || info.kind !== kind) problems.push(`Source page without matching raw source: ${entryName}`)
    }
  }
  // Log heading grammar: every "## " line after the H1 must match the grammar.
  const logPath = join(knowledge, "wiki", "log.md")
  if (files.includes(logPath)) {
    const lines = readFileSync(logPath, "utf8").split(/\r\n|\n/)
    for (const line of lines.slice(1)) {
      if (line.startsWith("## ") && !LOG_HEADING.test(line)) problems.push(`Malformed wiki log heading: ${line}`)
    }
    const entries = parseLog(readFileSync(logPath, "utf8"))
    for (const entry of entries) {
      if (entry.op !== "ingest") continue
      const linksToSource = [...entry.body.matchAll(/\]\(([^)]+)\)/g)].some((m) => {
        const link = m[1]!
        if (/^https?:\/\//.test(link) || link.startsWith("#")) return false
        const target = resolve(join(knowledge, "wiki"), link.split("#")[0]!)
        return contained(sourcesDir, target) && files.includes(target)
      })
      if (!linksToSource) problems.push(`Ingest log entry does not link an existing source page: [${entry.at}] ${entry.title}`)
    }
  }
  return problems
}
