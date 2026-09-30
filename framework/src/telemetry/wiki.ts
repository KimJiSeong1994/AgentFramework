import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { listToolOutcomes, type ToolOutcome } from "./outcomes.ts"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const markdown = (text: string) => text.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
}
function safeDirectory(root: string, segments: string[]): string {
  let path = root
  for (const segment of segments) {
    path = join(path, segment)
    if (existsSync(path)) {
      const info = lstatSync(path)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Wiki directory must not be a symlink or file")
    } else mkdirSync(path, { mode: 0o700 })
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
  const temp = `${path}.${process.pid}.tmp`
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

/** Deterministic capture is not semantic ingestion: the coding agent maintains synthesis pages separately. */
export function captureWiki(worktree: string) {
  const root = realpathSync(worktree)
  const knowledge = safeDirectory(root, ["knowledge"])
  const lock = join(knowledge, ".capture.lock")
  writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 })
  try {
    const raw = safeDirectory(root, ["knowledge", "raw", "tool-runs"])
    const wiki = safeDirectory(root, ["knowledge", "wiki"])
    const sources = safeDirectory(root, ["knowledge", "wiki", "sources"])
    const reports = safeDirectory(root, ["knowledge", "wiki", "reports"])
    const index = join(wiki, "index.md")
    const log = join(wiki, "log.md")
    safeFile(index); safeFile(log)
    if (!existsSync(index) || !existsSync(log) || !existsSync(join(knowledge, "AGENTS.md"))) throw new Error("Wiki schema, index and log must exist before capture")
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
    const marker = `source_id: ${sourceName}`
    const logText = readFileSync(log, "utf8")
    if (!logText.includes(marker)) {
      // Append, never regenerate: LLM ingest/query/lint entries must survive future captures.
      writeFileSync(log, `\n## [${new Date().toISOString()}] capture | 도구 실행 관측\n\n- ${marker}\n- [원본 요약](sources/${sourcePage}); ${observations.length}/${totalCount}개 관측.\n- 의미적 ingest는 아직 실행하지 않았습니다.\n`, { flag: "a", mode: 0o600 })
    }
    return { source: relative(root, rawPath), summary: relative(root, join(sources, sourcePage)), report: relative(root, join(reports, "tool-outcomes.md")), created, observations: observations.length, totalCount }
  } finally { unlinkSync(lock) }
}

/** Structural checks only; semantic contradictions/stale claims require the wiki-maintainer agent. */
export function lintWiki(worktree: string): string[] {
  const root = realpathSync(worktree)
  const knowledge = join(root, "knowledge")
  const problems: string[] = []
  if (existsSync(join(knowledge, ".capture.lock"))) return ["Wiki capture lock exists; verify the owning process before retrying"]
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
  const indexed = new Set<string>()
  for (const path of files) {
    if (path.endsWith(".md")) {
      const text = readFileSync(path, "utf8")
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1]!
        if (/^https?:\/\//.test(link) || link.startsWith("#")) continue
        if (/^[a-z]+:/i.test(link)) { problems.push(`Unsupported link scheme in ${relative(root, path)}`); continue }
        const target = resolve(dirname(path), link.split("#")[0]!)
        if (!contained(knowledge, target) || !files.includes(target)) problems.push(`Broken or unsafe link: ${relative(root, path)} -> ${link}`)
        else if (path === index) indexed.add(target)
      }
    } else if (path.startsWith(join(knowledge, "raw", "tool-runs") + "/") && path.endsWith(".json")) {
      const text = readFileSync(path, "utf8")
      if (path !== join(dirname(path), `${digest(text)}.json`)) problems.push(`Raw source integrity mismatch: ${relative(root, path)}`)
      try {
        const data = JSON.parse(text)
        if (data.schemaVersion !== 1 || data.kind !== "tool-outcome-snapshot" || !Array.isArray(data.observations)) problems.push(`Invalid raw source schema: ${relative(root, path)}`)
      } catch { problems.push(`Invalid raw source JSON: ${relative(root, path)}`) }
    }
  }
  for (const path of files.filter((p) => p.startsWith(join(knowledge, "wiki") + "/") && p.endsWith(".md") && p !== index)) {
    if (!indexed.has(path)) problems.push(`Wiki page missing from index: ${relative(root, path)}`)
  }
  return problems
}
