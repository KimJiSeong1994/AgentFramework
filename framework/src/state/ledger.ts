// Task ledger (stage 2): the single source of truth for delegated work.
// Control plane = <state root>/sessions/<id>/ledger.json (outside the worktree, see store.ts; atomic writes, one
// writer: this plugin). Data plane = <worktree>/.lca/handoffs/<id>/task-<n>.md (10-20 lines per finished task, read
// by humans; the next worker's prompt gets only a short status+files summary). Every orchestration decision reads
// this file, never model text.
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { AUTOLOAD_PROTECTED } from "../config.ts"
import { readJsonChecked, sessionDir, writeJsonAtomic } from "./store.ts"

export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled"

export type TaskKind = "code" | "data"

/**
 * `kind: "code"` (default): a worker session + verify command + reviewer. `kind: "data"`: title = the question, the
 * data-analyst answers it (SQL:/RESULT:/ANSWER: contract), `verify` names a check suite (`default` built in), the
 * framework re-executes the SQL + runs the checks, the data-verifier judges. Nothing on disk is touched.
 */
/** Tag of an approved plan workflow; tasks without a tag belong to ordinary delegate calls. */
export type WorkflowTag = { id: string; planSha: string }

export type TaskInput = { title: string; detail?: string; verify?: string; kind?: TaskKind; wf?: WorkflowTag }

export type VerifyResult = { command: string; ok: boolean; exitCode: number | null; timedOut: boolean; output: string }
export type ReviewResult = { verdict: "accept" | "reject" | "skipped" | "error"; reason?: string; sessionID?: string; aborted?: boolean }

export type LedgerTask = TaskInput & {
  id: string
  n: number
  /** delegate call that created the task (1-based per session); "Task N of M" counts within the batch */
  batch: number
  status: TaskStatus
  attempts: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  workerSessionID?: string
  /** every worker/reviewer child session used for this task (attempt order) */
  childSessions: string[]
  filesChanged?: string[]
  /** worker's final text, trimmed to config.delegate.report_max_chars */
  report?: string
  verify_result?: VerifyResult
  review?: ReviewResult
  /** why it failed / was cancelled */
  error?: string
  /** the worker's own "Open issues:" line when it was not "none" (a signal the framework reads: no retry on a blocked task) */
  blocked?: string
  /** handoff file, relative to the worktree */
  handoff?: string
  /** data task: the SQL the analyst reported (re-executed by the framework) and its ANSWER line */
  sql?: string
  answer?: string
}

export type Ledger = {
  version: 1
  sessionID: string
  createdAt: number
  updatedAt: number
  /** set by the queue while it runs; cleared when it exits (used by idle loop + HUD) */
  running?: { taskId: string; childSessionID?: string; since: number }
  /** idle loop: open task ids main has already been told about (resume offer is made once per task) */
  resumeNotifiedFor?: string[]
  tasks: LedgerTask[]
}

export const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "running"])

export function ledgerPath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "ledger.json")
}

export function handoffDir(worktree: string, sessionID: string): string {
  return join(worktree, ".lca", "handoffs", sessionID)
}

export function emptyLedger(sessionID: string, now = Date.now()): Ledger {
  return { version: 1, sessionID, createdAt: now, updatedAt: now, tasks: [] }
}

export type ReadLedgerResult = { ledger: Ledger; corrupt?: string }

/** Strict pure parser for status and other read-only consumers; never quarantines or writes. */
export function parseLedger(value: unknown, sessionID: string): Ledger {
  const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === "object" && !Array.isArray(input)
  const text = (input: unknown): input is string => typeof input === "string"
  const timestamp = (input: unknown): boolean => typeof input === "number" && Number.isFinite(input) && input >= 0
  const integer = (input: unknown, min = 0): boolean => Number.isSafeInteger(input) && (input as number) >= min
  const optional = (record: Record<string, unknown>, key: string, check: (input: unknown) => boolean): boolean => !(key in record) || check(record[key])
  const stringArray = (input: unknown): boolean => Array.isArray(input) && input.every(text)
  const verifyResult = (input: unknown): boolean => object(input) && text(input.command) && typeof input.ok === "boolean" &&
    (input.exitCode === null || Number.isSafeInteger(input.exitCode)) && typeof input.timedOut === "boolean" && text(input.output)
  const reviewResult = (input: unknown): boolean => object(input) && ["accept", "reject", "skipped", "error"].includes(input.verdict as string) &&
    optional(input, "reason", text) && optional(input, "sessionID", text) && optional(input, "aborted", x => typeof x === "boolean")
  const workflowTag = (input: unknown): boolean => object(input) && text(input.id) && text(input.planSha)
  const taskShape = (input: unknown): boolean => object(input) && text(input.id) && input.id.length > 0 &&
    integer(input.n, 1) && integer(input.batch, 1) && ["pending", "running", "done", "failed", "cancelled"].includes(input.status as string) &&
    integer(input.attempts) && timestamp(input.createdAt) && stringArray(input.childSessions) && text(input.title) &&
    optional(input, "kind", x => x === "code" || x === "data") && optional(input, "detail", text) && optional(input, "verify", text) &&
    optional(input, "wf", workflowTag) && optional(input, "startedAt", timestamp) && optional(input, "finishedAt", timestamp) &&
    optional(input, "workerSessionID", text) && optional(input, "filesChanged", stringArray) && optional(input, "report", text) &&
    optional(input, "verify_result", verifyResult) && optional(input, "review", reviewResult) && optional(input, "error", text) &&
    optional(input, "blocked", text) && optional(input, "handoff", text) && optional(input, "sql", text) && optional(input, "answer", text)
  if (!object(value) || value.version !== 1 || value.sessionID !== sessionID ||
    !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !Array.isArray(value.tasks) ||
    (value.running !== undefined && (!object(value.running) || typeof value.running.taskId !== "string" || !value.running.taskId ||
      !timestamp(value.running.since) || !optional(value.running, "childSessionID", text))) ||
    (value.resumeNotifiedFor !== undefined && !stringArray(value.resumeNotifiedFor)) || !value.tasks.every(taskShape)) throw new Error("invalid ledger state")
  return value as Ledger
}

/** A corrupt file is moved aside (path in `corrupt`) instead of being overwritten by the next write. */
export function readLedgerChecked(worktree: string, sessionID: string): ReadLedgerResult {
  const r = readJsonChecked<Ledger | null>(ledgerPath(worktree, sessionID), null)
  const l = r.value
  if (!l || l.version !== 1 || !Array.isArray(l.tasks)) {
    if (l && !r.corrupt) {
      // parses but has the wrong shape: preserve it too
      const p = ledgerPath(worktree, sessionID)
      const moved = `${p}.corrupt-${Date.now()}`
      try {
        renameSync(p, moved)
      } catch {}
      return { ledger: emptyLedger(sessionID), corrupt: moved }
    }
    return { ledger: emptyLedger(sessionID), corrupt: r.corrupt }
  }
  return { ledger: l }
}

export function readLedger(worktree: string, sessionID: string): Ledger {
  return readLedgerChecked(worktree, sessionID).ledger
}

export function writeLedger(worktree: string, ledger: Ledger): Ledger {
  const next = { ...ledger, updatedAt: Date.now() }
  writeJsonAtomic(ledgerPath(worktree, ledger.sessionID), next)
  return next
}

/** Append tasks as one batch; ids continue the existing numbering so handoff files never collide. */
export function addTasks(ledger: Ledger, inputs: TaskInput[], now = Date.now(), tag?: WorkflowTag): { ledger: Ledger; added: LedgerTask[] } {
  let n = ledger.tasks.reduce((m, t) => Math.max(m, t.n), 0)
  const batch = ledger.tasks.reduce((m, t) => Math.max(m, t.batch ?? 1), 0) + 1
  const added: LedgerTask[] = inputs.map((input) => {
    n += 1
    return {
      id: `t${n}`,
      n,
      batch,
      title: oneLine(input.title, 200),
      detail: input.detail?.trim() || undefined,
      verify: input.verify?.trim() || undefined,
      kind: input.kind === "data" ? "data" : undefined,
      ...((tag ?? input.wf) ? { wf: tag ?? input.wf } : {}),
      status: "pending",
      attempts: 0,
      createdAt: now,
      childSessions: [],
    }
  })
  return { ledger: { ...ledger, tasks: [...ledger.tasks, ...added] }, added }
}

export function nextPending(ledger: Ledger): LedgerTask | undefined {
  return ledger.tasks.find((t) => t.status === "pending")
}

export function openTasks(ledger: Ledger): LedgerTask[] {
  return ledger.tasks.filter((t) => OPEN_STATUSES.has(t.status))
}

export function updateTask(ledger: Ledger, id: string, patch: Partial<LedgerTask>): Ledger {
  return { ...ledger, tasks: ledger.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
}

/** Mark every open task cancelled (superseded / user stop / queue ttl). Returns the ids affected. */
export function cancelOpen(ledger: Ledger, reason: string, now = Date.now()): { ledger: Ledger; ids: string[] } {
  const ids: string[] = []
  const tasks = ledger.tasks.map((t) => {
    if (!OPEN_STATUSES.has(t.status)) return t
    ids.push(t.id)
    return { ...t, status: "cancelled" as const, error: reason, finishedAt: now }
  })
  return { ledger: { ...ledger, tasks, running: undefined }, ids }
}

export function tasksForWorkflow(ledger: Ledger, wfId: string): LedgerTask[] {
  return ledger.tasks.filter((t) => t.wf?.id === wfId)
}

/**
 * Approved plan -> ledger, one pure transformation (written by the caller in a single ledger write). Idempotent per
 * planSha: tasks already tagged with this plan are never added twice. Every other open task is cancelled so the
 * approved plan is the only work the next `delegate resume` runs, and the new ids are marked as already offered so
 * the chat/idle resume offer does not misfire on the approve turn.
 */
export function approvePlanTasks(
  ledger: Ledger,
  inputs: TaskInput[],
  tag: WorkflowTag,
  now = Date.now(),
): { ledger: Ledger; added: LedgerTask[]; cancelledForeign: string[] } {
  const existing = ledger.tasks.filter((t) => t.wf?.id === tag.id && t.wf.planSha === tag.planSha)
  if (existing.length > 0) return { ledger, added: [], cancelledForeign: [] }
  const cancelledForeign: string[] = []
  const tasks = ledger.tasks.map((t) => {
    if (!OPEN_STATUSES.has(t.status) || t.wf?.id === tag.id) return t
    cancelledForeign.push(t.id)
    return { ...t, status: "cancelled" as const, error: `superseded by approved plan ${tag.id}`, finishedAt: now }
  })
  const r = addTasks({ ...ledger, tasks, running: undefined }, inputs, now, tag)
  const notified = new Set([...(r.ledger.resumeNotifiedFor ?? []), ...r.added.map((t) => t.id)])
  return { ledger: { ...r.ledger, resumeNotifiedFor: [...notified] }, added: r.added, cancelledForeign }
}

/** Stable hash of (id, status, attempts) — the idle loop's stagnation input for ledger-driven sessions. */
export function ledgerFingerprint(ledger: Ledger): string {
  const rows = ledger.tasks.map((t) => `${t.id}\u0000${t.status}\u0000${t.attempts}`)
  return createHash("sha1").update(rows.join("\n")).digest("hex")
}

export function counts(ledger: Ledger): Record<TaskStatus, number> {
  const c: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 }
  for (const t of ledger.tasks) c[t.status]++
  return c
}

export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}

export function tail(s: string, max: number): string {
  if (s.length <= max) return s
  return "…" + s.slice(s.length - max + 1)
}

export function head(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

/**
 * Files a worker must not modify: the test/check files named in the task's verify command (e.g. `test_rect.py` in
 * `python3 -m pytest -q test_rect.py`). Editing them makes the verify result meaningless (stage-2 negative e2e: a
 * worker rewrote an impossible assertion and the reviewer accepted it).
 */
export function protectedFiles(task: Pick<LedgerTask, "verify">): string[] {
  if (!task.verify) return []
  const out = new Set<string>()
  for (const tok of task.verify.split(/\s+/)) {
    const t = tok.replace(/^['"]|['"]$/g, "").replace(/::.*$/, "").replace(/^\.\//, "")
    if (/^[A-Za-z0-9_./-]+\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|kt|swift|ex|exs|sh)$/.test(t) && /(test|spec|check|verify)/i.test(t)) out.add(t)
  }
  return [...out]
}

/** Test-looking paths (used when the verify command names no file, e.g. `pytest -q tests/`, `bun test`, `make test`). */
export function isTestLikePath(p: string): boolean {
  return /(^|\/)(test_[^\/]+\.[a-z]+|[^\/]+_test\.[a-z]+|[^\/]+\.(test|spec)\.[a-z]+)$/i.test(p) || /(^|\/)(tests?|spec|specs|__tests__)\//.test(p)
}

function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$")
}

/** Runner-autoloaded files (conftest.py, pytest.ini, Makefile, package.json, ...) unless the task text names them. */
export function autoloadProtected(task: Pick<LedgerTask, "title" | "detail">, p: string): boolean {
  const name = basename(p)
  if (!AUTOLOAD_PROTECTED.some((g) => globToRe(g).test(name))) return false
  const text = `${task.title}\n${task.detail ?? ""}`
  return !(text.includes(name) || text.includes(p))
}

export type ViolationReport = {
  /** changed files that must be restored: named test files (exact path / path suffix), runner-autoloaded files, test-like files when nothing was named */
  violations: string[]
  /** same basename as a protected file in another directory: shown to the reviewer, not restored */
  suspicious: string[]
}

export function protectedViolations(changed: string[] | undefined, protectedList: string[], task?: Pick<LedgerTask, "title" | "detail">): ViolationReport {
  const out: ViolationReport = { violations: [], suspicious: [] }
  if (!changed?.length) return out
  const base = (p: string) => p.split("/").pop() ?? p
  for (const f of changed) {
    if (protectedList.some((p) => f === p || f.endsWith("/" + p))) out.violations.push(f)
    else if (task && autoloadProtected(task, f)) out.violations.push(f)
    else if (protectedList.length === 0 && task && isTestLikePath(f)) out.violations.push(f)
    else if (protectedList.some((p) => base(f) === base(p))) out.suspicious.push(f)
  }
  return out
}

/** The worker's "Open issues:" line when it is not "none" (report contract, see WORKER_PROMPT). */
export function openIssues(report: string | undefined): string | undefined {
  if (!report) return undefined
  const m = /^[ \t]*Open issues:[ \t]*(\S.*)$/im.exec(report) ?? /^[ \t]*Open issues:[ \t]*\n[ \t]*[-*][ \t]*(.+)$/im.exec(report)
  if (!m) return undefined
  const v = m[1]!.trim().replace(/^[-*][ \t]*/, "")
  if (!v || /^(none|n\/a|no|-|nothing)\.?$/i.test(v) || /^<\s*(?:none|n\/a|no|-|nothing)\.?\s*>$/i.test(v)) return undefined
  return oneLine(v, 200)
}

/** Review outcome as shown to main / humans (an unparseable verdict is reported as such, never as an error word). */
export function reviewLabel(r: ReviewResult | undefined): string | undefined {
  if (!r) return undefined
  if (r.verdict === "skipped") return r.reason && /snapshot|git/.test(r.reason) ? `review: skipped (${r.reason})` : undefined
  if (r.verdict === "error") {
    if (r.aborted) return "review: aborted"
    if (r.reason && /aborted/.test(r.reason)) return "review: aborted (external)"
    return "review: no verdict"
  }
  return `review: ${r.verdict}${r.reason ? ` (${oneLine(r.reason, 100)})` : ""}`
}

// ------------------------------------------------------------------ handoffs (data plane)

/** 10-20 line markdown handoff for one finished task. Returns the path relative to the worktree. */
export function writeHandoff(worktree: string, sessionID: string, task: LedgerTask): string {
  const dir = handoffDir(worktree, sessionID)
  const file = join(dir, `task-${task.n}.md`)
  const lines: string[] = [
    `# Task ${task.n}: ${task.title}`,
    ``,
    `- status: ${task.status}${task.error ? ` (${oneLine(task.error, 160)})` : ""}`,
    `- attempts: ${task.attempts}`,
  ]
  if (task.kind === "data") {
    if (task.answer) lines.push(`- answer: ${oneLine(task.answer, 300)}`)
    if (task.sql) lines.push(``, "```sql", ...task.sql.split("\n").slice(0, 30), "```", ``)
  } else lines.push(`- files changed: ${task.filesChanged?.length ? task.filesChanged.join(", ") : "none"}`)
  if (task.verify_result) {
    const v = task.verify_result
    lines.push(`- verify: ${v.ok ? "PASS" : v.timedOut ? "TIMEOUT" : `FAIL (exit ${v.exitCode})`} \`${oneLine(v.command, 120)}\``)
  } else if (task.verify) {
    lines.push(`- verify: not run \`${oneLine(task.verify, 120)}\``)
  }
  if (task.review) {
    const v = task.review.verdict === "error" ? (task.review.aborted ? "ABORTED" : "NO VERDICT") : task.review.verdict.toUpperCase()
    lines.push(`- review: ${v}${task.review.reason && task.review.verdict !== "error" ? ` — ${oneLine(task.review.reason, 160)}` : ""}`)
  }
  if (task.report) {
    lines.push(``, task.kind === "data" ? `## Analyst report` : `## Worker report`, ``)
    for (const l of task.report.split("\n").slice(0, 12)) lines.push(l)
  }
  if (task.verify_result && !task.verify_result.ok && task.verify_result.output) {
    lines.push(``, `## Verify output (tail)`, ``, "```", ...tail(task.verify_result.output, 800).split("\n").slice(-10), "```")
  }
  if (task.blocked) lines.push(`- worker reports: ${task.blocked}`)
  mkdirSync(dir, { recursive: true })
  // never write through a symlink a worker may have planted at .lca or .lca/handoffs (second review S7)
  const root = realpathSync.native(worktree)
  const real = realpathSync.native(dir)
  if (real !== root && !real.startsWith(root + "/")) throw new Error(`handoff dir escapes the worktree: ${dir}`)
  for (const part of [join(worktree, ".lca"), join(worktree, ".lca", "handoffs"), dir]) {
    if (lstatSync(part).isSymbolicLink()) throw new Error(`handoff path is a symlink: ${part}`)
  }
  // other repositories will not have .lca/handoffs in .gitignore: make the directory ignore itself
  const ignore = join(worktree, ".lca", "handoffs", ".gitignore")
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n")
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, lines.join("\n") + "\n")
  renameSync(tmp, file)
  return relativeToWorktree(worktree, file)
}

function relativeToWorktree(worktree: string, abs: string): string {
  const root = worktree.endsWith("/") ? worktree : worktree + "/"
  return abs.startsWith(root) ? abs.slice(root.length) : abs
}

/**
 * Context block for the next worker: one line per finished task of the same batch (status + files, and the failure
 * reason for failed ones), capped at `maxChars`. Kept tiny on purpose: it is the only cross-task memory a worker gets.
 */
export function handoffContext(ledger: Ledger, beforeTaskId: string, maxChars: number): string {
  const rows: string[] = []
  const current = ledger.tasks.find((t) => t.id === beforeTaskId)
  const batch = current?.batch ?? 1
  for (const t of ledger.tasks) {
    if (t.id === beforeTaskId) break
    if ((t.batch ?? 1) !== batch) continue
    if (t.status !== "done" && t.status !== "failed") continue
    const files = t.kind === "data" ? (t.answer ? ` [answer: ${oneLine(t.answer, 120)}]` : "") : t.filesChanged?.length ? ` [files: ${t.filesChanged.slice(0, 6).join(", ")}${t.filesChanged.length > 6 ? ", …" : ""}]` : ""
    const why = t.status === "failed" ? ` (${oneLine(t.blocked ?? t.error ?? "failed", 80)})` : ""
    rows.push(`- Task ${t.n} (${t.status}${why}): ${t.title}${files}`)
  }
  if (rows.length === 0) return ""
  const header = "Earlier tasks in this run:"
  let out = header
  for (const r of rows) {
    if (out.length + 1 + r.length > maxChars - 5) {
      out += "\n- …"
      break
    }
    out += "\n" + r
  }
  return out
}

/**
 * One-screen summary used as the delegate tool result and as the idle-loop message. Every task keeps its line and the
 * header/handoffs lines always survive; the budget grows with the task count and long titles/file lists are the first
 * things trimmed (review: a fixed 2000-char cap silently dropped the last tasks of a 12-task run).
 */
export function summarizeLedger(ledger: Ledger, taskIds?: string[], opts: { maxChars?: number; note?: string } = {}): string {
  const tasks = taskIds ? ledger.tasks.filter((t) => taskIds.includes(t.id)) : ledger.tasks
  const max = opts.maxChars ?? Math.max(2000, 200 * tasks.length)
  const c = { done: 0, failed: 0, cancelled: 0, open: 0 }
  for (const t of tasks) {
    if (t.status === "done") c.done++
    else if (t.status === "failed") c.failed++
    else if (t.status === "cancelled") c.cancelled++
    else c.open++
  }
  const header = `Delegate result: ${tasks.length} task(s) — ${c.done} done, ${c.failed} failed${c.cancelled ? `, ${c.cancelled} cancelled` : ""}${c.open ? `, ${c.open} not run` : ""}.`
  const failed = tasks.filter((t) => t.status === "failed")
  const footer: string[] = []
  if (failed.length) footer.push(`Handoffs with details: ${failed.map((t) => t.handoff).filter(Boolean).join(", ")}`)
  if (opts.note) footer.push(opts.note)

  const line = (t: LedgerTask, titleMax: number, filesMax: number) => {
    const bits: string[] = []
    if (t.kind === "data" && t.answer) bits.push(`answer: ${oneLine(t.answer, titleMax * 2)}`)
    if (t.filesChanged?.length) bits.push(`files: ${t.filesChanged.slice(0, filesMax).join(", ")}${t.filesChanged.length > filesMax ? ", …" : ""}`)
    if (t.verify_result) bits.push(`${t.kind === "data" ? "checks" : "verify"}: ${t.verify_result.ok ? "pass" : t.verify_result.timedOut ? "timeout" : "FAIL"}`)
    const rl = reviewLabel(t.review)
    if (rl) bits.push(rl)
    if (t.error && t.status !== "done") bits.push(`error: ${oneLine(t.error, 120)}`)
    if (t.blocked) bits.push(`${t.kind === "data" ? "analyst" : "worker"}: ${oneLine(t.blocked, 100)}`)
    return `${t.n}. [${t.status}] ${oneLine(t.title, titleMax)}${bits.length ? " — " + bits.join("; ") : ""}`
  }
  const fixed = header.length + footer.reduce((a, f) => a + f.length + 1, 0)
  let body = tasks.map((t) => line(t, 80, 5))
  let text = [header, ...body, ...footer].join("\n")
  if (text.length > max) {
    body = tasks.map((t) => line(t, 50, 2))
    text = [header, ...body, ...footer].join("\n")
  }
  if (text.length > max) {
    // last resort: hard-trim each task line equally, never drop one
    const per = Math.max(30, Math.floor((max - fixed - tasks.length) / Math.max(1, tasks.length)))
    body = body.map((l) => oneLine(l, per))
    text = [header, ...body, ...footer].join("\n")
  }
  return text
}
