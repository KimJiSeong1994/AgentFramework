// Serial worker queue (stage 2). One task at a time, each in a fresh child session of the main session:
//   snapshot -> worker prompt (blocking session.prompt) -> snapshot/diff -> protected-file + gaming checks
//   -> verify command -> reviewer gate -> ledger + handoff.
// Entry points: the `delegate` tool (blocks inside main's tool call; `resume: true` re-runs open tasks left by an
// interrupted run) — the idle loop / chat.message only tell main about open tasks, they never run the queue
// (second review F4: a queue running while main is idle races with user input). One runner per (plugin instance,
// main session). All decisions read the ledger file and process results; the only model text parsed is the
// reviewer's verdict line (that agent's output contract) and the worker's "Open issues:" line (report contract).
import type { HookDeps } from "../hooks/types.ts"
import { verifyCommandProblem } from "../config.ts"
import { readAbort, removeSessionDir } from "../state/store.ts"
import {
  addTasks,
  cancelOpen,
  handoffContext,
  head,
  nextPending,
  oneLine,
  openIssues,
  protectedFiles,
  protectedViolations,
  readLedger,
  tail,
  updateTask,
  writeHandoff,
  writeLedger,
  type Ledger,
  type LedgerTask,
  type ReviewResult,
  type TaskInput,
  type VerifyResult,
} from "../state/ledger.ts"
import { scanDiff } from "./gaming.ts"
import { getBackend } from "../data/backend.ts"
import { DEFAULT_SUITE, extractAnswer, formatCheckRun, loadSuite, runChecks, sampleRows, type CheckRun } from "../data/check.ts"
import type { LcaAgentName } from "../agents/prompts.ts"
import { startShell, type RunHandle } from "./shell.ts"
import { createSnapshotStore, type Snapshot } from "./snapshot.ts"
import { createTaskWorktree, type TaskWorktree } from "./worktree.ts"
import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { handoffDir } from "../state/ledger.ts"

export type QueueRun = {
  /** ids the run started with (pending at entry) */
  taskIds: string[]
  done: number
  failed: number
  cancelled: number
  /** the run was stopped by abort()/abort marker/queue ttl (remaining tasks cancelled) */
  aborted: boolean
  /** why it was aborted, when it was */
  abortReason?: string
  /** "already_running" when another run owned the session */
  skipped?: "already_running"
  /** review + protected-file guard were unavailable (not a git repository) */
  noSnapshot?: boolean
}

export type Queue = {
  /** append tasks to the session's ledger (does not run them) */
  add(sessionID: string, tasks: TaskInput[]): LedgerTask[]
  /** cancel every open task (e.g. superseded by a new delegate call); returns the ids */
  cancelOpen(sessionID: string, reason: string): string[]
  /** run every pending task serially; resolves when the queue is empty, aborted or already owned */
  run(sessionID: string): Promise<QueueRun>
  isRunning(sessionID: string): boolean
  /** stop after the current step: abort the child session / kill the verify command, cancel the rest.
   *  `discard`: the session was deleted — write nothing more to its state dir. */
  abort(sessionID: string, reason?: string, opts?: { discard?: boolean }): Promise<void>
}

type Active = {
  aborted: boolean
  reason?: string
  discard?: boolean
  child?: string
  verify?: RunHandle
  startedAt: number
  promise: Promise<QueueRun>
}

const registry = new WeakMap<HookDeps, Queue>()

export function getQueue(deps: HookDeps): Queue {
  let q = registry.get(deps)
  if (!q) {
    q = createQueue(deps)
    registry.set(deps, q)
  }
  return q
}

export function createQueue(deps: HookDeps): Queue {
  const active = new Map<string, Active>()
  const cfg = () => deps.config.delegate

  const add: Queue["add"] = (sessionID, tasks) => {
    const { ledger, added } = addTasks(readLedger(deps.worktree, sessionID), tasks)
    writeLedger(deps.worktree, ledger)
    deps.log("ledger: tasks added", { sessionID, ids: added.map((t) => t.id) })
    return added
  }

  const cancelOpenTasks: Queue["cancelOpen"] = (sessionID, reason) => {
    const { ledger, ids } = cancelOpen(readLedger(deps.worktree, sessionID), reason)
    if (ids.length) {
      writeLedger(deps.worktree, ledger)
      deps.log("ledger: open tasks cancelled", { sessionID, ids, reason })
    }
    return ids
  }

  const run: Queue["run"] = (sessionID) => {
    const existing = active.get(sessionID)
    if (existing) return Promise.resolve({ taskIds: [], done: 0, failed: 0, cancelled: 0, aborted: false, skipped: "already_running" })
    const entry: Active = { aborted: false, startedAt: Date.now(), promise: Promise.resolve() as unknown as Promise<QueueRun> }
    active.set(sessionID, entry)
    entry.promise = runLoop(sessionID, entry)
      .catch((e: unknown) => {
        // never leave the ledger with a running marker after an internal failure: the task that was running is
        // `failed (queue error)`, the rest is cancelled
        const msg = (e as Error)?.message ?? String(e)
        deps.log("queue crashed", { sessionID, error: msg })
        if (!entry.discard) {
          let ledger = readLedger(deps.worktree, sessionID)
          const running = ledger.tasks.find((t) => t.status === "running")
          if (running) ledger = updateTask(ledger, running.id, { status: "failed", error: `queue error: ${head(msg, 200)}`, finishedAt: Date.now() })
          writeLedger(deps.worktree, cancelOpen(ledger, `queue error: ${head(msg, 200)}`).ledger)
        }
        return { taskIds: [], done: 0, failed: 0, cancelled: 0, aborted: true, abortReason: `queue error: ${msg}` } as QueueRun
      })
      .finally(() => active.delete(sessionID))
    return entry.promise
  }

  const abort: Queue["abort"] = async (sessionID, reason = "aborted", opts = {}) => {
    const entry = active.get(sessionID)
    if (!entry) return
    entry.aborted = true
    entry.reason = reason
    if (opts.discard) entry.discard = true
    entry.verify?.kill(reason)
    if (entry.child) await abortSession(deps, entry.child)
  }

  function abortRequested(sessionID: string, entry: Active): string | undefined {
    if (entry.aborted) return entry.reason ?? "aborted"
    const marker = readAbort(deps.worktree, sessionID)
    if (marker) return marker.reason ?? "aborted"
    // checked between tasks only: a task that started late may run past the cap by up to one task
    if (Date.now() - entry.startedAt > cfg().queue_ttl_ms) return "queue ttl exceeded"
    return undefined
  }

  async function runLoop(sessionID: string, entry: Active): Promise<QueueRun> {
    const result: QueueRun = { taskIds: [], done: 0, failed: 0, cancelled: 0, aborted: false }
    let ledger = readLedger(deps.worktree, sessionID)
    // A crashed run may have left a task `running`; give it its attempt back and run it again.
    if (ledger.tasks.some((t) => t.status === "running")) {
      for (const t of ledger.tasks) {
        if (t.status !== "running") continue
        ledger = updateTask(ledger, t.id, { status: "pending", attempts: Math.max(0, t.attempts - 1), error: "interrupted; restarted" })
      }
      ledger = writeLedger(deps.worktree, { ...ledger, running: undefined })
    }
    result.taskIds = ledger.tasks.filter((t) => t.status === "pending").map((t) => t.id)

    for (;;) {
      ledger = readLedger(deps.worktree, sessionID)
      const task = nextPending(ledger)
      if (!task) break
      const why = abortRequested(sessionID, entry)
      if (why) {
        entry.aborted = true
        entry.reason = why
        const c = cancelOpen(ledger, why)
        if (!entry.discard) writeLedger(deps.worktree, c.ledger)
        result.cancelled += c.ids.length
        break
      }
      const finished = await runTask(sessionID, entry, task, result)
      if (finished.status === "done") result.done++
      else if (finished.status === "failed") result.failed++
      else if (finished.status === "cancelled") result.cancelled++
    }
    if (entry.aborted) {
      result.aborted = true
      result.abortReason = entry.reason
    }
    deps.log("queue finished", { sessionID, ...result })
    return result
  }

  async function runTask(sessionID: string, entry: Active, task0: LedgerTask, result: QueueRun): Promise<LedgerTask> {
    if (task0.kind === "data") return runDataTask(sessionID, entry, task0)
    const c = cfg()
    let task = task0
    let ledger = readLedger(deps.worktree, sessionID)
    let rejectReason: string | undefined
    // Optional isolation: the task runs in its own linked git worktree (worker session + verify bound to it) and its
    // diff is applied to the main worktree only when accepted. Falls back to in-place when there is no commit yet.
    let wt: TaskWorktree | null = null
    if (c.worktree) {
      wt = await createTaskWorktree(deps.worktree, sessionID, task.id, c.diff_exclude)
      if (wt) deps.log("task worktree", { sessionID, task: task.id, path: wt.path })
      else deps.log("task worktree unavailable (no git repository or no commit yet): running in place", { sessionID, task: task.id })
    }
    const root = wt?.path ?? deps.worktree
    // One snapshot store + one "before" tree per task: a retry is judged on the task's cumulative diff (attempt 1 may
    // already have done the work; the retry then changes little or nothing).
    const store = await createSnapshotStore(root)
    if (!store) result.noSnapshot = true
    const before: Snapshot = store ? await store.snapshot(c.diff_exclude) : null
    const prot = protectedFiles(task)
    const cancelled = (): LedgerTask => finish(sessionID, entry, ledger, { ...task, status: "cancelled", error: entry.reason ?? "aborted", finishedAt: Date.now() })
    try {
      while (task.attempts < c.max_attempts) {
        task = { ...task, status: "running", attempts: task.attempts + 1, startedAt: task.startedAt ?? Date.now() }
        ledger = writeLedger(deps.worktree, { ...updateTask(ledger, task.id, task), running: { taskId: task.id, since: Date.now() } })
        deps.log("task start", { sessionID, task: task.id, attempt: task.attempts })

        const worker = await runChild(deps, entry, sessionID, "worker", `lca task ${task.n}: ${task.title}`, workerPrompt(ledger, task, rejectReason, c.handoff_context_chars), c.task_ttl_ms, (child) => {
          ledger = writeLedger(deps.worktree, { ...ledger, running: { taskId: task.id, childSessionID: child, since: Date.now() } })
        }, wt?.path)
        task = { ...task, workerSessionID: worker.sessionID ?? task.workerSessionID, childSessions: [...task.childSessions, ...(worker.sessionID ? [worker.sessionID] : [])] }
        if (worker.status === "aborted") return cancelled()
        task.report = head((worker.text ?? "").trim(), c.report_max_chars) || undefined
        task.blocked = openIssues(task.report)
        if (worker.status === "error") task.error = worker.error

        // ---- what changed (cumulative for the task)
        const after: Snapshot = store ? await store.snapshot(c.diff_exclude) : null
        const diff = store ? await store.diff(before, after, c.diff_max_chars) : null
        task.filesChanged = diff?.files ?? task.filesChanged

        // ---- protected files: restore BEFORE verify so the check runs on honest files; gaming shapes in the code
        const report = protectedViolations(task.filesChanged, prot, task)
        if (report.violations.length && store) {
          const restored = await store.restore(before, report.violations)
          deps.log("task restored protected files", { sessionID, task: task.id, restored })
          task.filesChanged = task.filesChanged?.filter((f) => !report.violations.includes(f))
        }
        const scan = diff ? scanDiff(diff.diff, [...prot, ...report.violations]) : { strong: [], weak: [] }
        if (entry.aborted) return cancelled()

        // ---- verify (code-side, never trusted from the worker's report); the command was validated at delegate
        // time, re-checked here because the ledger could come from an older run
        let verify: VerifyResult | undefined
        if (task.verify) {
          const problem = verifyCommandProblem(task.verify, c.verify_allow)
          if (problem) {
            verify = { command: task.verify, ok: false, exitCode: null, timedOut: false, output: `verify command refused: ${problem}` }
          } else if (report.violations.length) {
            verify = { command: task.verify, ok: false, exitCode: null, timedOut: false, output: `(void: protected file modified: ${report.violations.join(", ")})` }
          } else {
            const handle = startShell(task.verify, {
              cwd: wt ? wt.path : deps.directory,
              timeoutMs: c.verify_timeout_ms,
              maxOutputChars: c.verify_output_chars,
              env: { PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1", PYTHONDONTWRITEBYTECODE: "1" },
            })
            entry.verify = handle
            if (entry.aborted) handle.kill(entry.reason) // /stop arrived between the check above and the spawn
            const r = await handle.result
            entry.verify = undefined
            verify = { command: task.verify, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, output: r.killed ? `(killed: ${entry.reason ?? "aborted"})\n${r.output}` : r.output }
            deps.log("task verify", { sessionID, task: task.id, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, killed: r.killed, ms: r.ms })
          }
          task.verify_result = verify
        }
        if (entry.aborted) return cancelled()
        const verified = !!verify && verify.ok

        // ---- reviewer gate (only when there is something to judge and nothing above already failed)
        let review: ReviewResult = { verdict: "skipped" }
        if (!store) review = { verdict: "skipped", reason: "no snapshot (not a git repository): review and protected-file guard unavailable" }
        else if (c.review && worker.status === "ok" && !report.violations.length && !scan.strong.length && (!verify || verify.ok)) {
          if (!diff || diff.files.length === 0) review = { verdict: "skipped", reason: "no file changes" }
          else review = await runReview(sessionID, entry, task, diff.diff, verify, prot, report.suspicious, scan.weak, c.review_ttl_ms, wt?.path)
        }
        task.review = review
        if (review.aborted || entry.aborted) {
          // a /stop during the review of an already verified change: keep the work, note the missing verdict
          if (verified && !report.violations.length && !scan.strong.length) return finish(sessionID, entry, ledger, { ...task, status: "done", error: `review aborted (${entry.reason ?? "aborted"})`, finishedAt: Date.now() })
          return cancelled()
        }

        const lastAttempt = task.attempts >= c.max_attempts
        let failure: string | undefined
        if (worker.status === "error") failure = `worker error: ${worker.error}`
        else if (report.violations.length) failure = `modified protected file(s): ${report.violations.join(", ")} — they were restored and the verify result does not count; make the code under test pass instead`
        else if (scan.strong.length) failure = `test-gaming pattern in the code: ${scan.strong.join("; ")} — write code that is correct for any input`
        else if (verify && !verify.ok) failure = `verify ${verify.timedOut ? "timed out" : verify.exitCode === null ? "refused" : `failed (exit ${verify.exitCode})`}: ${tail(verify.output, 300)}`
        else if (review.verdict === "reject") {
          // A REJECT on a task whose verify command passed is retried once, then advisory (review_strict: still fails).
          if (!verified || c.review_strict || !lastAttempt) failure = `review rejected: ${review.reason ?? ""}`
        } else if (review.verdict === "error" && c.review_strict && !verified) failure = "review gave no verdict"

        if (!failure) {
          const advisory = review.verdict === "reject" ? `accepted with review objection: ${review.reason ?? ""}` : undefined
          if (wt) {
            // accepted: bring the task's changes into the main worktree (in code; a patch that no longer applies is a
            // blocked task, the patch stays with the handoffs for a human)
            const m = await wt.merge(c.diff_exclude)
            if (!m.ok) {
              let kept = m.patch
              try {
                const dir = handoffDir(deps.worktree, sessionID)
                mkdirSync(dir, { recursive: true })
                kept = join(dir, `task-${task.n}.patch`)
                copyFileSync(m.patch, kept)
              } catch {}
              deps.log("task worktree merge failed", { sessionID, task: task.id, reason: m.reason, patch: kept })
              return finish(sessionID, entry, ledger, { ...task, status: "failed", blocked: m.reason, error: `not merged: ${m.reason} (patch: ${kept})`, finishedAt: Date.now() })
            }
            task.filesChanged = m.files
            deps.log("task worktree merged", { sessionID, task: task.id, files: m.files.length })
          }
          return finish(sessionID, entry, ledger, { ...task, status: "done", error: advisory, finishedAt: Date.now() })
        }
        rejectReason = failure
        task = { ...task, error: failure }
        ledger = writeLedger(deps.worktree, updateTask(ledger, task.id, task))
        deps.log("task attempt failed", { sessionID, task: task.id, attempt: task.attempts, failure: oneLine(failure.split("\n")[0] ?? "", 120) })
        // The worker said the task cannot be done honestly and verify agrees: a retry would only waste the slot.
        if (task.blocked && verify && !verify.ok && !report.violations.length) {
          deps.log("task blocked by worker report, no retry", { sessionID, task: task.id, blocked: task.blocked })
          break
        }
      }
      return finish(sessionID, entry, ledger, { ...task, status: "failed", finishedAt: Date.now() })
    } finally {
      store?.dispose()
      // a failed or cancelled task's worktree changes are discarded with it (the main worktree never saw them)
      if (wt) await wt.remove()
    }
  }

  /**
   * Data task: analyst child session -> SQL extracted from its text contract -> re-executed + check suite (code-side,
   * the analyst's RESULT block is never trusted) -> data-verifier verdict -> ledger + handoff. No snapshot, no files.
   * Same retry/advisory rules as code tasks: a failed check retries once with the reason; a REJECT after passing
   * checks is advisory on the last attempt unless review_strict.
   */
  async function runDataTask(sessionID: string, entry: Active, task0: LedgerTask): Promise<LedgerTask> {
    const c = cfg()
    const d = deps.config.data
    let task = task0
    let ledger = readLedger(deps.worktree, sessionID)
    let rejectReason: string | undefined
    const cancelled = (): LedgerTask => finish(sessionID, entry, ledger, { ...task, status: "cancelled", error: entry.reason ?? "aborted", finishedAt: Date.now() })
    const suiteName = task.verify?.trim() || DEFAULT_SUITE.name
    while (task.attempts < c.max_attempts) {
      task = { ...task, status: "running", attempts: task.attempts + 1, startedAt: task.startedAt ?? Date.now() }
      ledger = writeLedger(deps.worktree, { ...updateTask(ledger, task.id, task), running: { taskId: task.id, since: Date.now() } })
      deps.log("data task start", { sessionID, task: task.id, attempt: task.attempts })

      const analyst = await runChild(deps, entry, sessionID, "data-analyst", `lca data ${task.n}: ${task.title}`, analystPrompt(ledger, task, rejectReason, c.handoff_context_chars), c.task_ttl_ms, (child) => {
        ledger = writeLedger(deps.worktree, { ...ledger, running: { taskId: task.id, childSessionID: child, since: Date.now() } })
      })
      task = { ...task, workerSessionID: analyst.sessionID ?? task.workerSessionID, childSessions: [...task.childSessions, ...(analyst.sessionID ? [analyst.sessionID] : [])] }
      if (analyst.status === "aborted") return cancelled()
      const text = (analyst.text ?? "").trim()
      task.report = head(text, c.report_max_chars) || undefined
      if (analyst.status === "error") task.error = analyst.error
      const parsed = extractAnswer(text)
      task.sql = parsed.sql
      task.answer = parsed.answer
      // the analyst says the data cannot answer (ANSWER without SQL): a blocked task, nothing to retry
      task.blocked = !parsed.sql && parsed.answer ? oneLine(parsed.answer, 200) : undefined

      // ---- checks (code-side): re-execute the reported SQL and run the suite(s)
      let check: CheckRun | undefined
      if (parsed.sql) {
        try {
          const suites = suiteName === DEFAULT_SUITE.name ? [DEFAULT_SUITE] : [DEFAULT_SUITE, loadSuite(deps.worktree, d.checks_dir, suiteName)]
          check = await runChecks(getBackend(deps), parsed.sql, suites, { timeoutMs: d.statement_timeout_ms, maxRows: d.max_rows })
        } catch (e) {
          check = { suite: suiteName, ok: false, results: [], error: `checks could not run: ${(e as Error).message.slice(0, 200)}` }
        }
        const output = check.error && !check.results.length ? check.error : formatCheckRun(check)
        task.verify_result = { command: `data_check ${suiteName}`, ok: check.ok, exitCode: check.ok ? 0 : 1, timedOut: false, output: head(output, c.verify_output_chars) }
        deps.log("data task checks", { sessionID, task: task.id, ok: check.ok, failed: check.results.filter((r) => !r.ok).map((r) => r.name) })
      } else {
        task.verify_result = { command: `data_check ${suiteName}`, ok: false, exitCode: null, timedOut: false, output: task.blocked ? `(not run: analyst reports the data cannot answer: ${task.blocked})` : "(not run: no SQL: block in the analyst's answer)" }
      }
      if (entry.aborted) return cancelled()
      const verified = !!check?.ok

      // ---- verifier gate: only a checked answer is worth a verdict
      let review: ReviewResult = { verdict: "skipped" }
      if (c.review && analyst.status === "ok" && verified && parsed.sql) {
        review = await runVerify(sessionID, entry, task, parsed.sql, check!, c.review_ttl_ms)
      }
      task.review = review
      if (review.aborted || entry.aborted) {
        if (verified) return finish(sessionID, entry, ledger, { ...task, status: "done", error: `verification aborted (${entry.reason ?? "aborted"})`, finishedAt: Date.now() })
        return cancelled()
      }

      const lastAttempt = task.attempts >= c.max_attempts
      let failure: string | undefined
      if (analyst.status === "error") failure = `analyst error: ${analyst.error}`
      else if (task.blocked) failure = `analyst reports: ${task.blocked}`
      else if (!parsed.sql) failure = "the answer had no SQL: block (contract: SQL: / RESULT: / ANSWER:)"
      else if (check && !check.ok) failure = `checks failed: ${check.error ?? check.results.filter((r) => !r.ok).map((r) => `${r.name} (${r.detail})`).join("; ")}`
      else if (review.verdict === "reject") {
        if (c.review_strict || !lastAttempt) failure = `verifier rejected: ${review.reason ?? ""}`
      }

      if (!failure) {
        const advisory = review.verdict === "reject" ? `accepted with verifier objection: ${review.reason ?? ""}` : undefined
        return finish(sessionID, entry, ledger, { ...task, status: "done", error: advisory, finishedAt: Date.now() })
      }
      rejectReason = failure
      task = { ...task, error: failure }
      ledger = writeLedger(deps.worktree, updateTask(ledger, task.id, task))
      deps.log("data task attempt failed", { sessionID, task: task.id, attempt: task.attempts, failure: oneLine(failure.split("\n")[0] ?? "", 120) })
      if (task.blocked) break
    }
    return finish(sessionID, entry, ledger, { ...task, status: "failed", finishedAt: Date.now() })
  }

  async function runVerify(sessionID: string, entry: Active, task: LedgerTask, sql: string, check: CheckRun, ttl: number): Promise<ReviewResult> {
    const r = await runChild(deps, entry, sessionID, "data-verifier", `lca verify ${task.n}: ${task.title}`, verifierPrompt(task, sql, check), ttl)
    if (r.status === "aborted") return { verdict: "error", reason: "aborted", sessionID: r.sessionID, aborted: true }
    if (r.status !== "ok") return { verdict: "error", reason: r.error ?? r.status, sessionID: r.sessionID }
    return { ...parseVerdict(r.text ?? ""), sessionID: r.sessionID }
  }

  function finish(sessionID: string, entry: Active, ledger: Ledger, task: LedgerTask): LedgerTask {
    let handoff: string | undefined
    if (!entry.discard) {
      // data plane: a failure here must never change the control-plane outcome
      try {
        handoff = writeHandoff(deps.worktree, sessionID, task)
      } catch (e) {
        deps.log("handoff write failed", { sessionID, task: task.id, error: (e as Error).message })
      }
    }
    const done = { ...task, handoff }
    if (!entry.discard) writeLedger(deps.worktree, { ...updateTask(ledger, task.id, done), running: undefined })
    // child sessions' plugin state dirs (session.json etc.) are never needed again
    for (const child of done.childSessions) removeSessionDir(deps.worktree, child)
    if (done.review?.sessionID) removeSessionDir(deps.worktree, done.review.sessionID)
    deps.log("task finished", { sessionID, task: task.id, status: done.status, files: done.filesChanged?.length ?? 0 })
    return done
  }

  async function runReview(
    sessionID: string,
    entry: Active,
    task: LedgerTask,
    diff: string,
    verify: VerifyResult | undefined,
    prot: string[],
    suspicious: string[],
    hints: string[],
    ttl: number,
    directory?: string,
  ): Promise<ReviewResult> {
    const r = await runChild(deps, entry, sessionID, "reviewer", `lca review ${task.n}: ${task.title}`, reviewerPrompt(task, diff, verify, prot, suspicious, hints), ttl, undefined, directory)
    if (r.status === "aborted") return { verdict: "error", reason: "aborted", sessionID: r.sessionID, aborted: true }
    if (r.status !== "ok") return { verdict: "error", reason: r.error ?? r.status, sessionID: r.sessionID }
    return { ...parseVerdict(r.text ?? ""), sessionID: r.sessionID }
  }

  return { add, cancelOpen: cancelOpenTasks, run, isRunning: (id) => active.has(id), abort }
}

// ------------------------------------------------------------------ prompts (dynamic user messages, not prefix)

export function workerPrompt(ledger: Ledger, task: LedgerTask, previousFailure: string | undefined, contextChars: number): string {
  const batch = ledger.tasks.filter((t) => (t.batch ?? 1) === (task.batch ?? 1))
  const index = Math.max(1, batch.findIndex((t) => t.id === task.id) + 1)
  const lines = [`Task ${index} of ${batch.length}: ${task.title}`]
  if (task.detail) lines.push(task.detail)
  if (task.verify) lines.push(`Run this once before you finish: ${task.verify}`)
  const prot = protectedFiles(task)
  if (prot.length) lines.push(`Never edit ${prot.join(", ")}. If the check cannot pass with honest code, report that under Open issues.`)
  const ctx = handoffContext(ledger, task.id, contextChars)
  if (ctx) lines.push("", ctx)
  if (previousFailure) {
    lines.push(
      "",
      `A previous worker already changed files for this task, but the result was not accepted. Reason: ${oneLine(previousFailure, 300)}`,
      "Read the files first and keep what already works. Make the verify command pass by changing only the code this task owns; never edit test files. If it cannot pass that way, do not force it: explain under Open issues and stop.",
    )
  }
  return lines.join("\n")
}

/** Data task: the question (title) + constraints (detail); a retry carries the failure reason. */
export function analystPrompt(ledger: Ledger, task: LedgerTask, previousFailure: string | undefined, contextChars: number): string {
  const lines = [`Question: ${task.title}`]
  if (task.detail) lines.push(`Constraints: ${task.detail}`)
  const ctx = handoffContext(ledger, task.id, contextChars)
  if (ctx) lines.push("", ctx)
  if (previousFailure) {
    lines.push("", `A previous answer to this question was not accepted. Reason: ${oneLine(previousFailure, 300)}`, "Fix the query accordingly (re-check the mapping with resolve_semantics or schema_lookup if a column or filter was wrong). Same output contract: SQL:, RESULT:, ANSWER:.")
  }
  return lines.join("\n")
}

/** Data verifier: question, SQL, the framework's own execution sample and check lines. Verdict on the last line. */
export function verifierPrompt(task: LedgerTask, sql: string, check: CheckRun): string {
  const lines = [`Question: ${task.title}`]
  if (task.detail) lines.push(`Constraints: ${task.detail}`)
  lines.push("", "SQL:", sql, "", "Result (executed by the framework, first rows):", sampleRows(check.rows, 10), "", `Checks (${check.suite}):`, formatCheckRun(check) || "(none)")
  return lines.join("\n")
}

export function reviewerPrompt(task: LedgerTask, diff: string, verify: VerifyResult | undefined, prot: string[] = [], suspicious: string[] = [], hints: string[] = []): string {
  const lines = [`Task: ${task.title}`]
  if (task.detail) lines.push(`Scope: ${task.detail}`)
  if (verify) lines.push(`Verification: \`${verify.command}\` -> ${verify.ok ? "exit 0 (pass)" : `exit ${verify.exitCode} (fail)`}`, tail(verify.output, 600) || "(no output)")
  else lines.push("Verification: none provided by the task; judge the diff only.")
  if (prot.length) lines.push(`Protected (must not appear in the diff): ${prot.join(", ")}`)
  if (suspicious.length) lines.push(`Same name as a protected file (check they are not shadowing it): ${suspicious.join(", ")}`)
  if (hints.length) lines.push(`Suspicious lines: ${hints.join("; ")}`)
  lines.push("", "Diff:", diff || "(empty)")
  return lines.join("\n")
}

/**
 * Reviewer output contract: the LAST line is ACCEPT or REJECT: <reason> (after four short answers, see
 * REVIEWER_PROMPT). Tolerated deviations of a local model: markdown decoration at the line head, "Verdict:" prefix,
 * ACCEPTED/REJECTED, Korean 승인/거부, the verdict among the first or last three lines. A line that merely recites
 * the rule ("REJECT when ...") is not a verdict. Anything else is `error` (no verdict) — never silently accept.
 */
export function parseVerdict(text: string): ReviewResult {
  const strip = (l: string) => l.replace(/^[\s*_`#>\-]+/, "").replace(/[\s*_`]+$/, "").trim()
  const lines = text.split("\n").map(strip).filter((l) => l.length > 0)
  const re = /^(?:(?:verdict|판정|결과)[\s*_`]*[:：]?[\s*_`]*)?(accept(?:ed)?|reject(?:ed)?|승인|거부)(?![A-Za-z])[\s*_`]*[:：\-—]?\s*(.*)$/i
  const recital = /^(?:if|when|only|unless|because|iff)\b/i
  const candidates = [...lines.slice(-3).reverse(), ...lines.slice(0, 3)]
  for (const line of candidates) {
    const m = re.exec(line)
    if (!m) continue
    const word = m[1]!.toLowerCase()
    const rest = (m[2] ?? "").trim()
    if (recital.test(rest)) continue
    if (word.startsWith("accept") || word === "승인") return { verdict: "accept" }
    return { verdict: "reject", reason: rest || undefined }
  }
  // strong signal anywhere: an upper-case verdict word starting a line, not followed by a rule word
  const buried = lines.find((l) => /^(ACCEPT|REJECT)(ED)?\b(?!\s+(if|when|only|unless|because|iff)\b)/.test(l))
  if (buried) {
    if (buried.startsWith("ACCEPT")) return { verdict: "accept" }
    return { verdict: "reject", reason: buried.replace(/^REJECT(ED)?\b\s*[:\-—]?\s*/, "").trim() || undefined }
  }
  return { verdict: "error", reason: `unparseable verdict: ${head(lines[lines.length - 1] ?? "", 80)}` }
}

// ------------------------------------------------------------------ child sessions

export type ChildRun = { status: "ok" | "error" | "aborted"; sessionID?: string; text?: string; error?: string }

/** Tools a child session must never see even if an agent config drifts (defense in depth: session-level deny). */
export const CHILD_TOOL_DENY = { task: false, delegate: false, todowrite: false, todoread: false, webfetch: false }

async function runChild(
  deps: HookDeps,
  entry: Active,
  parentID: string,
  agent: LcaAgentName,
  title: string,
  text: string,
  ttlMs: number,
  onCreated?: (sessionID: string) => void,
  directory?: string,
): Promise<ChildRun> {
  if (entry.aborted) return { status: "aborted" }
  const session = (deps.client as any).session
  let sessionID: string | undefined
  // `directory` binds the child session (and every tool it runs) to another directory: the SDK's per-request
  // `?directory=` (worktree isolation)
  const query = directory ? { directory } : undefined
  try {
    const created = await session.create({ body: { parentID, title }, ...(query ? { query } : {}) })
    sessionID = created?.data?.id
    if (!sessionID) return { status: "error", error: `session.create failed: ${describeError(created?.error)}` }
  } catch (e) {
    return { status: "error", error: `session.create threw: ${(e as Error).message}` }
  }
  entry.child = sessionID
  onCreated?.(sessionID)
  if (entry.aborted) {
    entry.child = undefined
    return { status: "aborted", sessionID }
  }

  const body: Record<string, unknown> = { agent, tools: CHILD_TOOL_DENY, parts: [{ type: "text", text }] }
  const model = deps.config.models[agent]
  if (model) {
    const [providerID, ...rest] = model.split("/")
    if (providerID && rest.length) body.model = { providerID, modelID: rest.join("/") }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ttlMs)
  })
  try {
    const raced = await Promise.race([session.prompt({ path: { id: sessionID }, body, ...(query ? { query } : {}) }), timeout])
    if (raced === "timeout") {
      await abortSession(deps, sessionID)
      return { status: "error", sessionID, error: `child session timed out after ${Math.round(ttlMs / 1000)}s` }
    }
    const res: any = raced
    if (entry.aborted) return { status: "aborted", sessionID }
    if (res?.error) return { status: "error", sessionID, error: `prompt error: ${describeError(res.error)}` }
    const data = res?.data ?? res
    const info = data?.info
    if (info?.error) {
      const name = info.error?.name ?? "error"
      // Aborted by someone else (repetition guard, user closing the child): a failed attempt, not a queue abort.
      if (name === "MessageAbortedError") return { status: "error", sessionID, error: "child session aborted (repetition guard or external abort)", text: extractText(data?.parts) }
      return { status: "error", sessionID, error: `${name}: ${info.error?.data?.message ?? ""}`.trim(), text: extractText(data?.parts) }
    }
    return { status: "ok", sessionID, text: extractText(data?.parts) }
  } catch (e) {
    return { status: entry.aborted ? "aborted" : "error", sessionID, error: (e as Error).message }
  } finally {
    if (timer) clearTimeout(timer)
    if (entry.child === sessionID) entry.child = undefined
  }
}

function describeError(e: unknown): string {
  if (!e) return "no id"
  if (typeof e === "string") return e
  const o = e as any
  const name = o.name ?? o.error?.name
  const msg = o.data?.message ?? o.message ?? o.error?.message
  if (name || msg) return [name, msg].filter(Boolean).join(": ")
  try {
    return JSON.stringify(e).slice(0, 200)
  } catch {
    return String(e)
  }
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
    .map((p: any) => p.text as string)
    .join("\n")
}

async function abortSession(deps: HookDeps, sessionID: string): Promise<void> {
  try {
    await (deps.client as any).session.abort({ path: { id: sessionID } })
  } catch (e) {
    deps.log("child abort failed", { sessionID, error: (e as Error).message })
  }
}
