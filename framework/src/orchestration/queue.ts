// Serial worker queue. One task at a time, each in a fresh host execution:
//   snapshot -> host worker run -> snapshot/diff -> protected-file + gaming checks
//   -> verify command -> reviewer gate -> ledger + handoff.
// Entry points: the `delegate` tool (blocks inside main's tool call; `resume: true` re-runs open tasks left by an
// interrupted run) — the idle loop / chat.message only tell main about open tasks, they never run the queue
// (second review F4: a queue running while main is idle races with user input). One runner per (plugin instance,
// main session). All decisions read the ledger file and process results; the only model text parsed is the
// reviewer's verdict line (that agent's output contract) and the worker's "Open issues:" line (report contract).
import { createHash, randomUUID } from "node:crypto"
import { verifyCommandProblem } from "../config.ts"
import { readAbort, removeSessionDir, sessionDir } from "../state/store.ts"
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
import { DEFAULT_SUITE, extractAnswer, formatCheckRun, sampleRows, type CheckRun } from "../data/check.ts"
import type { LcaAgentName } from "../agents/prompts.ts"
import type { SkillTaskFactInput, SkillVerificationFactInput } from "../telemetry/skills.ts"
import { settled, strictQuiescent, type ExecutionClaim } from "../hosts/run-state.ts"
import { beginExecutionActivity } from "../hosts/runtime.ts"
import type { ExecutionHandle, ExecutionReconciliation, ExecutionReference, ExecutionRole, ExecutionRuntime } from "../hosts/types.ts"
import type { VerificationHandle, VerificationResult } from "./verifier.ts"
import { createSnapshotStore, type Snapshot } from "./snapshot.ts"
import { createTaskWorktree, hasTaskWorktreeState, reopenTaskWorktree, type TaskWorktree } from "./worktree.ts"
import { readWorkflow } from "../flow/state.ts"
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
  /** Another queue/review already owns this worktree's in-process execution slot. */
  skipped?: "already_running" | "execution_busy"
  /** review + protected-file guard were unavailable (not a git repository) */
  noSnapshot?: boolean
}

/** Exact delegate provenance only; callers without host context leave lineage unknown. */
export type QueueOrigin = { messageID?: string; resumed?: boolean }

export type Queue = {
  /** append tasks to the session's ledger (does not run them) */
  add(sessionID: string, tasks: TaskInput[]): LedgerTask[]
  /** cancel every open task (e.g. superseded by a new delegate call); returns the ids */
  cancelOpen(sessionID: string, reason: string): string[]
  /** run every pending task serially; resolves when the queue is empty, aborted or already owned */
  run(sessionID: string, origin?: QueueOrigin): Promise<QueueRun>
  isRunning(sessionID: string): boolean
  /** stop after the current step: abort the child session / kill the verify command, cancel the rest.
   *  `discard`: the session was deleted — write nothing more to its state dir. */
  abort(sessionID: string, reason?: string, opts?: { discard?: boolean }): Promise<void>
}

type Active = {
  aborted: boolean
  reason?: string
  discard?: boolean
  workflowID?: string
  workflowCancellationObserved?: boolean
  abortWork?: Promise<void>
  child?: { id: string; handle: ExecutionHandle; claim: ExecutionClaim }
  preparingExecutionID?: string
  cancelWaiter?: () => void
  claim?: ExecutionClaim
  unresolved?: boolean
  recoveryBlocked?: boolean
  verify?: { id: string; handle: VerificationHandle; claim: ExecutionClaim; run?: Promise<VerificationResult>; cancelled?: VerificationResult }
  attempt?: AttemptObservation
  startedAt: number
  promise: Promise<QueueRun>
}

async function beforeDeadline<T>(work: Promise<T>, deadlineAt: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(0, deadlineAt - Date.now()))
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

type AttemptLineage = {
  ownerSessionID: string
  taskID: string
  attemptID: string
  messageID?: string
  resumeOfAttemptID?: string
  resumeRequested?: boolean
  workflowID?: string
  planSha256?: string
}

type AttemptObservation = AttemptLineage & {
  verificationID: string
  verificationStartedAt?: number
  verificationFinishedAt?: number
  verificationStatus?: SkillVerificationFactInput["status"]
  verificationExitCode?: number | null
  taskObserved: boolean
  codeVerification: boolean
  review?: ReviewResult
  completed: boolean
}

function bestEffortTaskObservation(deps: ExecutionRuntime, fact: SkillTaskFactInput): void {
  try { deps.observe?.task?.(fact) } catch { /* Observation never changes queue behavior. */ }
}

function bestEffortVerificationObservation(deps: ExecutionRuntime, fact: SkillVerificationFactInput): void {
  try { deps.observe?.verification?.(fact) } catch { /* Observation never changes queue behavior. */ }
}

function attemptContext(attempt: AttemptObservation) {
  return {
    taskID: attempt.taskID, attemptID: attempt.attemptID, ownerSessionID: attempt.ownerSessionID,
    taskKind: attempt.codeVerification ? "code" as const : "data" as const,
    messageID: attempt.messageID ?? null, resumeOfAttemptID: attempt.resumeOfAttemptID ?? null,
    resumeRequested: attempt.resumeRequested ?? null,
    workflowID: attempt.workflowID ?? null, planSha256: attempt.planSha256 ?? null,
  }
}

function observeChild(deps: ExecutionRuntime, attempt: AttemptObservation, childSessionID: string, agent: LcaAgentName, status: "started" | "done" | "failed" | "cancelled", childMessageID?: string): void {
  const role = actorRole(agent)
  bestEffortTaskObservation(deps, {
    ...attemptContext(attempt), sessionID: childSessionID,
    phase: status === "started" ? "pending" : "terminal", status,
    childSessionID, childMessageID: childMessageID ?? null, actualRole: role,
    roleBasis: role === "unknown" ? "unknown" : "code_owned",
  })
}

function actorRole(agent: LcaAgentName): NonNullable<SkillTaskFactInput["actualRole"]> {
  if (agent === "worker" || agent === "reviewer" || agent === "data-analyst" || agent === "data-verifier") return agent
  return "unknown"
}

function taskStatus(status: LedgerTask["status"] | "open"): NonNullable<SkillVerificationFactInput["taskStatus"]> {
  if (status === "done" || status === "failed" || status === "cancelled") return status
  return "open"
}

function reviewVerdict(review: ReviewResult | undefined): NonNullable<SkillVerificationFactInput["reviewVerdict"]> {
  return review?.verdict ?? "unknown"
}

const registry = new WeakMap<ExecutionRuntime, Queue>()

export function getQueue(deps: ExecutionRuntime): Queue {
  let q = registry.get(deps)
  if (!q) {
    q = createQueue(deps)
    registry.set(deps, q)
  }
  return q
}

export function createQueue(deps: ExecutionRuntime): Queue {
  const active = new Map<string, Active>()
  const cfg = () => deps.config.delegate

  function createAttempt(sessionID: string, task: LedgerTask, origin: QueueOrigin | undefined, resumeOfAttemptID?: string, codeVerification = true): AttemptObservation {
    return {
      ownerSessionID: sessionID,
      taskID: task.id,
      workflowID: task.wf?.id, planSha256: task.wf?.planSha, resumeRequested: origin?.resumed,
      attemptID: randomUUID(),
      ...(origin?.messageID ? { messageID: origin.messageID } : {}),
      // An explicit resume request is not a stable relation without the predecessor's stored UUID.
      ...(resumeOfAttemptID ? { resumeOfAttemptID } : {}),
      verificationID: randomUUID(),
      taskObserved: false,
      codeVerification,
      completed: false,
    }
  }

  function observeTaskStart(attempt: AttemptObservation): void {
    bestEffortTaskObservation(deps, {
      ...attemptContext(attempt), sessionID: attempt.ownerSessionID,
      phase: "pending", status: "started", taskStatus: "open",
    })
    attempt.taskObserved = true
  }

  function startCodeVerification(attempt: AttemptObservation): void {
    const startedAt = Date.now()
    attempt.verificationStartedAt = startedAt
    attempt.verificationStatus = "started"
    bestEffortVerificationObservation(deps, {
      sessionID: attempt.ownerSessionID, verificationID: attempt.verificationID,
      taskID: attempt.taskID, attemptID: attempt.attemptID, phase: "pending", status: "started",
      codeOwned: true, startedAt,
    })
  }

  function setCodeVerificationResult(attempt: AttemptObservation, status: SkillVerificationFactInput["status"], exitCode?: number | null): void {
    attempt.verificationStatus = status
    attempt.verificationExitCode = exitCode
    attempt.verificationFinishedAt = Date.now()
  }

  function finishAttemptObservation(
    attempt: AttemptObservation | undefined,
    attemptStatus: "done" | "failed" | "cancelled",
    taskResult: LedgerTask["status"] | "open",
    review: ReviewResult | undefined,
    codeVerification = attempt?.codeVerification ?? true,
  ): void {
    if (!attempt || attempt.completed) return
    const finishedAt = Date.now()
    if (codeVerification) {
      let status = attempt.verificationStatus
      if (!status) {
        status = "not_run"
        attempt.verificationFinishedAt = finishedAt
      } else if (status === "started") {
        status = "unknown"
        attempt.verificationFinishedAt = finishedAt
      }
      attempt.verificationStatus = status
      bestEffortVerificationObservation(deps, {
        sessionID: attempt.ownerSessionID, verificationID: attempt.verificationID,
        taskID: attempt.taskID, attemptID: attempt.attemptID,
        phase: "terminal", status,
        codeOwned: true, exitCode: attempt.verificationExitCode ?? null,
        ...(attempt.verificationStartedAt === undefined ? {} : { startedAt: attempt.verificationStartedAt }),
        finishedAt: attempt.verificationFinishedAt ?? finishedAt,
        ...(attempt.verificationStartedAt !== undefined && (attempt.verificationFinishedAt ?? finishedAt) >= attempt.verificationStartedAt ? {
          durationMs: (attempt.verificationFinishedAt ?? finishedAt) - attempt.verificationStartedAt,
        } : {}),
        taskStatus: taskStatus(taskResult), reviewVerdict: reviewVerdict(review),
      })
    }
    if (attempt.taskObserved) bestEffortTaskObservation(deps, {
      ...attemptContext(attempt), sessionID: attempt.ownerSessionID,
      phase: "terminal", status: attemptStatus, taskStatus: taskStatus(taskResult),
    })
    attempt.completed = true
  }

  const add: Queue["add"] = (sessionID, tasks) => {
    if (!deps.dataChecks && tasks.some((task) => task.kind === "data")) throw new Error("data checks unavailable for this execution runtime")
    const { ledger, added } = addTasks(readLedger(deps.worktree, sessionID), tasks)
    writeLedger(deps.worktree, ledger)
    deps.log("ledger: tasks added", { sessionID, ids: added.map((t) => t.id) })
    return added
  }

  const cancelOpenTasks: Queue["cancelOpen"] = (sessionID, reason) => {
    if (deps.runs.status().executions.some(execution => !settled(execution))) return []
    const { ledger, ids } = cancelOpen(readLedger(deps.worktree, sessionID), reason)
    if (ids.length) {
      writeLedger(deps.worktree, ledger)
      deps.log("ledger: open tasks cancelled", { sessionID, ids, reason })
    }
    return ids
  }

  const run: Queue["run"] = (sessionID, origin) => {
    const existing = active.get(sessionID)
    if (existing) return Promise.resolve({ taskIds: [], done: 0, failed: 0, cancelled: 0, aborted: false, skipped: "already_running" })
    const releaseActivity = beginExecutionActivity(deps, sessionID, "queue")
    if (!releaseActivity) return Promise.resolve({ taskIds: [], done: 0, failed: 0, cancelled: 0, aborted: false, skipped: "execution_busy" })
    let workflowID: string | undefined
    try {
      const workflow = readWorkflow(deps.worktree)
      if (workflow?.sessionID === sessionID) workflowID = workflow.id
    } catch (error) {
      deps.log("workflow cancellation watch unavailable", { sessionID, error: String(error) })
    }
    const entry: Active = { aborted: false, startedAt: Date.now(), promise: Promise.resolve() as unknown as Promise<QueueRun> }
    entry.workflowID = workflowID
    active.set(sessionID, entry)
    let workflowCancelTimer: ReturnType<typeof setInterval> | undefined
    const observe = () => {
      observeWorkflowCancellation(sessionID, entry)
      if (entry.aborted && workflowCancelTimer) clearInterval(workflowCancelTimer)
    }
    if (workflowID) {
      observe()
      if (!entry.workflowCancellationObserved) workflowCancelTimer = setInterval(observe, 50)
    }
    entry.promise = runLoop(sessionID, entry, origin)
      .catch((e: unknown) => {
        // Do not rewrite the ledger when startup recovery cannot prove quiescence: a later safe retry needs its exact
        // running/pending task state. After dispatch starts, retain the existing failed/cancelled repair behavior.
        const msg = (e as Error)?.message ?? String(e)
        if (entry.attempt) {
          finishAttemptObservation(entry.attempt, "failed", "failed", entry.attempt.review)
          entry.attempt = undefined
        }
        deps.log("queue crashed", { sessionID, error: msg })
        if (!entry.discard && !entry.recoveryBlocked) {
          let ledger = readLedger(deps.worktree, sessionID)
          const running = ledger.tasks.find((t) => t.status === "running")
          if (running) ledger = updateTask(ledger, running.id, {
            status: entry.aborted && entry.unresolved ? "cancelled" : "failed",
            error: entry.aborted && entry.unresolved ? `cancelled; execution fenced: ${head(msg, 200)}` : `queue error: ${head(msg, 200)}`,
            finishedAt: Date.now(),
          })
          if (!entry.unresolved) ledger = cancelOpen(ledger, `queue error: ${head(msg, 200)}`).ledger
          writeLedger(deps.worktree, ledger)
        }
        return { taskIds: [], done: 0, failed: 0, cancelled: 0, aborted: true, abortReason: entry.reason ?? `queue error: ${msg}` } as QueueRun
      })
      .finally(async () => {
        try {
          if (entry.abortWork) await entry.abortWork
        } finally {
          if (workflowCancelTimer) clearInterval(workflowCancelTimer)
          active.delete(sessionID)
          if (entry.claim && !entry.unresolved) {
            try { deps.runs.release(entry.claim) }
            catch (error) { deps.log("queue claim release failed", { sessionID, error: String(error) }) }
          }
          releaseActivity()
        }
      })
    return entry.promise
  }

  const abort: Queue["abort"] = async (sessionID, reason = "aborted", opts = {}) => {
    const entry = active.get(sessionID)
    if (!entry) return
    entry.aborted = true
    entry.reason = reason
    if (opts.discard) entry.discard = true
    if (entry.abortWork) return entry.abortWork
    const work = (async () => {
      if (entry.verify) {
        const current = entry.verify
        const deadlineAt = Date.now() + 2000
        deps.runs.recordCancel(current.claim, current.id, { requestedAt: Date.now() })
        try {
          const cancellation = await Promise.race([
            current.handle.requestCancel(reason, deadlineAt),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
          ])
          if (cancellation?.acknowledged) deps.runs.recordCancel(current.claim, current.id, { requestedAt: Date.now(), acknowledgedAt: Date.now() })
          const outcome = cancellation?.outcome ?? await Promise.race([
            current.run ?? Promise.resolve(null),
            new Promise<null>(resolve => setTimeout(() => resolve(null), Math.max(0, deadlineAt - Date.now()))),
          ])
          if (outcome) current.cancelled = outcome
          if (!outcome) {
            deps.runs.fence(current.claim, current.id, "verifier cancellation has no terminal result")
            entry.unresolved = true
          }
        } catch (error) {
          deps.runs.fence(current.claim, current.id, "verifier cancellation failed")
          entry.unresolved = true
          deps.log("verifier abort failed", { executionID: current.id, error: String(error) })
        } finally { entry.cancelWaiter?.() }
      }
      if (entry.child) {
        try { await cancelChild(deps, entry.child, reason) }
        finally { entry.cancelWaiter?.() }
      } else {
        if (entry.claim && entry.preparingExecutionID) deps.runs.recordCancel(entry.claim, entry.preparingExecutionID, { requestedAt: Date.now() })
        entry.cancelWaiter?.()
      }
    })()
    entry.abortWork = work
    return work
  }

  function observeWorkflowCancellation(sessionID: string, entry: Active): void {
    if (!entry.workflowID || entry.workflowCancellationObserved || entry.aborted) return
    let current: ReturnType<typeof readWorkflow>
    try { current = readWorkflow(deps.worktree) }
    catch (error) {
      deps.log("workflow cancellation poll failed", { sessionID, workflowID: entry.workflowID, error: String(error) })
      return
    }
    if (current?.id !== entry.workflowID || current.sessionID !== sessionID || !(current.pendingCancel || current.phase === "cancelled")) return
    entry.workflowCancellationObserved = true
    entry.aborted = true
    entry.reason = `plan workflow ${entry.workflowID} cancelled`
    void abort(sessionID, entry.reason).catch(error => {
      deps.log("workflow cancellation observation failed", { sessionID, workflowID: entry.workflowID, error: String(error) })
    })
  }

  function abortRequested(sessionID: string, entry: Active): string | undefined {
    observeWorkflowCancellation(sessionID, entry)
    if (entry.aborted) return entry.reason ?? "aborted"
    const marker = readAbort(deps.worktree, sessionID)
    if (marker) return marker.reason ?? "aborted"
    // checked between tasks only: a task that started late may run past the cap by up to one task
    if (Date.now() - entry.startedAt > cfg().queue_ttl_ms) return "queue ttl exceeded"
    return undefined
  }

  function mayComplete(sessionID: string, entry: Active): boolean {
    if (abortRequested(sessionID, entry) || !entry.claim) return false
    try { deps.runs.assertQuiescent(entry.claim); return !abortRequested(sessionID, entry) }
    catch { return false }
  }

  async function runLoop(sessionID: string, entry: Active, origin?: QueueOrigin): Promise<QueueRun> {
    const result: QueueRun = { taskIds: [], done: 0, failed: 0, cancelled: 0, aborted: false }
    entry.recoveryBlocked = true
    entry.claim = deps.runs.claim(sessionID, deps.instance, process.pid)
    // A previous owner may have stopped after dispatch. Do not replay until every persisted
    // execution meets its settlement contract; legacy parent exit is trusted-work settlement, not containment.
    for (const execution of deps.runs.status().executions) {
      if (settled(execution)) continue
      if (execution.kind === "verifier") {
        if (execution.generation < entry.claim.generation && execution.verifierDispatch === "prepared" &&
          !execution.terminal && !execution.fence && !execution.reconciliation) {
          deps.runs.retireUndispatchedVerifier(entry.claim, execution.executionId)
          continue
        }
        if (execution.profile === "legacy-unowned") {
          if (!execution.fence) deps.runs.fence(entry.claim, execution.executionId, "legacy verifier dispatch or retirement cannot be proven after restart")
          continue
        }
        if (execution.boundaryRef && "kind" in execution.boundaryRef && execution.boundaryRef.kind === "verifier") {
          try {
            const state = await beforeDeadline(deps.verifier.reconcile(execution.boundaryRef), Date.now() + 2000, "verifier restart reconciliation")
            deps.runs.reconcile(entry.claim, execution.executionId, {
              outcome: state.outcome, quiescent: false,
              evidence: "verifier restart cannot prove qualified retirement",
            })
          } catch (error) {
            deps.runs.fence(entry.claim, execution.executionId, `verifier recovery failed: ${String(error).slice(0, 200)}`)
            entry.unresolved = true
            throw error
          }
        }
        continue
      }
      if (strictQuiescent(execution)) continue
      let reconciliation: ExecutionReconciliation = { outcome: "unknown", quiescent: false, evidence: "no persisted vendor reference" }
      if (execution.vendorRef) {
        try { reconciliation = await beforeDeadline(deps.host.reconcile(JSON.parse(execution.vendorRef) as ExecutionReference), Date.now() + 2000, "host restart reconciliation") }
        catch (error) {
          deps.runs.fence(entry.claim, execution.executionId, `host recovery failed: ${String(error).slice(0, 200)}`)
          entry.unresolved = true
          throw error
        }
      }
      deps.runs.reconcile(entry.claim, execution.executionId, reconciliation)
    }
    try { deps.runs.assertQuiescent(entry.claim) }
    catch (error) { entry.unresolved = true; throw error }
    let ledger = readLedger(deps.worktree, sessionID)
    const c = cfg()
    const reopenedWorktrees = new Map<string, TaskWorktree>()
    // Ownership and the original durable baseline must be authenticated before repairing any running-task
    // ledger state. In particular, do not let a missing or substituted worktree become a fresh baseline.
    for (const task of ledger.tasks) {
      if (task.kind === "data" || (task.status !== "running" && task.status !== "pending")) continue
      const residue = hasTaskWorktreeState(deps.worktree, sessionID, task.id)
      if (!c.worktree) {
        if (residue) throw new Error(`task worktree recovery refused for ${task.id}: isolation is disabled; existing worktree was preserved`)
        continue
      }
      const interrupted = task.status === "running" || task.startedAt !== undefined
      const resumedPreDispatch = task.status === "pending" && origin?.resumed === true && residue
      if (interrupted || resumedPreDispatch) {
        reopenedWorktrees.set(task.id, await reopenTaskWorktree(deps.worktree, sessionID, task.id, c.diff_exclude))
      } else if (residue) {
        throw new Error(`task worktree recovery refused for ${task.id}: existing worktree requires an explicit resumed run`)
      }
    }
    entry.recoveryBlocked = false
    // A crashed run may have left a task `running`; give it its attempt back and run it again. The ledger counter is
    // not a stable identity, so the restarted attempt gets a new UUID and no guessed resumeOfAttemptID.
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
      const finished = await runTask(sessionID, entry, task, result, origin, reopenedWorktrees.get(task.id))
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

  async function runTask(sessionID: string, entry: Active, task0: LedgerTask, result: QueueRun, origin?: QueueOrigin, reopenedWorktree?: TaskWorktree): Promise<LedgerTask> {
    if (task0.kind === "data") return runDataTask(sessionID, entry, task0, origin)
    const c = cfg()
    let task = task0
    let ledger = readLedger(deps.worktree, sessionID)
    let rejectReason: string | undefined
    let attempt: AttemptObservation | undefined
    let previousAttemptID: string | undefined
    let verifiedTree: string | undefined
    // Optional isolation: the task runs in its own linked git worktree (worker session + verify bound to it) and its
    // diff is applied to the main worktree only when accepted. Falls back to in-place when there is no commit yet.
    let wt: TaskWorktree | null = reopenedWorktree ?? null
    if (c.worktree && !wt) {
      if (hasTaskWorktreeState(deps.worktree, sessionID, task.id)) {
        entry.recoveryBlocked = true
        throw new Error(`task worktree recovery refused for ${task.id}: existing worktree was not authenticated before dispatch`)
      }
      wt = await createTaskWorktree(deps.worktree, sessionID, task.id, c.diff_exclude)
      if (wt) deps.log("task worktree", { sessionID, task: task.id, path: wt.path })
      else deps.log("task worktree unavailable (no git repository or no commit yet): running in place", { sessionID, task: task.id })
    }
    const root = wt?.path ?? deps.worktree
    const snapshotDirectory = join(sessionDir(deps.worktree, sessionID), "snapshots", task.id)
    // One snapshot store + one "before" tree per task: a retry is judged on the task's cumulative diff (attempt 1 may
    // already have done the work; the retry then changes little or nothing).
    const store = wt ? wt.store : await createSnapshotStore(root, snapshotDirectory)
    if (!store && !wt) result.noSnapshot = true
    let before: Snapshot = wt ? wt.baseline : null
    let baselineError: string | undefined
    if (!wt && store) {
      try { before = await store.baseline(c.diff_exclude, task.startedAt !== undefined) }
      catch (error) { baselineError = (error as Error).message ?? String(error) }
    }
    const prot = protectedFiles(task)
    let removeWorktree = false
    const finishObserved = (next: LedgerTask, status: "done" | "failed" | "cancelled"): LedgerTask => {
      const done = finish(sessionID, entry, ledger, next)
      finishAttemptObservation(attempt, status, status, done.review)
      attempt = undefined
      entry.attempt = undefined
      return done
    }
    const cancelled = (): LedgerTask => finishObserved(
      { ...task, status: "cancelled", error: entry.reason ?? "aborted", finishedAt: Date.now() }, "cancelled")
    try {
      if (!store || !before) return finishObserved(
        { ...task, status: "failed", error: baselineError ? `could not ${task.startedAt === undefined ? "snapshot" : "reuse"} the task baseline: ${head(baselineError, 200)}` : "could not snapshot the task baseline", finishedAt: Date.now() }, "failed")
      while (task.attempts < c.max_attempts) {
        observeWorkflowCancellation(sessionID, entry)
        if (entry.aborted) return cancelled()
        verifiedTree = undefined
        task = { ...task, status: "running", attempts: task.attempts + 1, startedAt: task.startedAt ?? Date.now() }
        ledger = writeLedger(deps.worktree, { ...updateTask(ledger, task.id, task), running: { taskId: task.id, since: Date.now() } })
        deps.log("task start", { sessionID, task: task.id, attempt: task.attempts })
        attempt = createAttempt(sessionID, task, origin, previousAttemptID)
        entry.attempt = attempt
        observeTaskStart(attempt)

        const worker = await runChild(deps, entry, sessionID, "worker", `lca task ${task.n}: ${task.title}`, workerPrompt(ledger, task, rejectReason, c.handoff_context_chars), c.task_ttl_ms, (child) => {
          ledger = writeLedger(deps.worktree, { ...ledger, running: { taskId: task.id, childSessionID: child, since: Date.now() } })
        }, wt?.path, attempt)
        task = { ...task, workerSessionID: worker.sessionID ?? task.workerSessionID, childSessions: [...task.childSessions, ...(worker.sessionID ? [worker.sessionID] : [])] }
        if (worker.status === "aborted") return cancelled()
        task.report = head((worker.text ?? "").trim(), c.report_max_chars) || undefined
        task.blocked = openIssues(task.report)
        if (worker.status === "error") task.error = worker.error

        // ---- what changed (cumulative for the task)
        const after: Snapshot = await store.snapshot(c.diff_exclude)
        const diff = await store.diff(before, after, c.diff_max_chars)
        if (!after || !diff) {
          if (!wt) entry.unresolved = true
          try { await store.restore(before, protectedFiles(task)) }
          catch { entry.unresolved = true }
          if (entry.unresolved) throw new Error("could not restore or snapshot the task; queue fenced")
          return finishObserved({ ...task, status: "failed", error: "could not snapshot or diff the task", finishedAt: Date.now() }, "failed")
        }
        task.filesChanged = diff?.files ?? task.filesChanged

        // ---- protected files: restore BEFORE verify so the check runs on honest files; gaming shapes in the code
        const report = protectedViolations(task.filesChanged, prot, task)
        if (report.violations.length) {
          let restored: string[]
          try { restored = await store.restore(before, report.violations) }
          catch {
            entry.unresolved = true
            throw new Error("protected file restoration failed; queue fenced")
          }
          deps.log("task restored protected files", { sessionID, task: task.id, restored })
          if (!report.violations.every(path => restored.includes(path))) {
            entry.unresolved = true
            throw new Error("protected file restoration incomplete; queue fenced")
          }
          task.filesChanged = task.filesChanged?.filter((f) => !report.violations.includes(f))
        }
        const scan = diff && !diff.truncated ? scanDiff(diff.diff, [...prot, ...report.violations]) : { strong: [], weak: [] }
        observeWorkflowCancellation(sessionID, entry)
        if (entry.aborted) return cancelled()

        // ---- verify (code-side, never trusted from the worker's report); the command was validated at delegate
        // time, re-checked here because the ledger could come from an older run
        let verify: VerifyResult | undefined
        if (task.verify) {
          const problem = verifyCommandProblem(task.verify, c.verify_allow)
          if (problem) {
            setCodeVerificationResult(attempt!, "refused", null)
            verify = { command: task.verify, ok: false, exitCode: null, timedOut: false, output: `verify command refused: ${problem}` }
          } else if (report.violations.length) {
            setCodeVerificationResult(attempt!, "invalidated", null)
            verify = { command: task.verify, ok: false, exitCode: null, timedOut: false, output: `(void: protected file modified: ${report.violations.join(", ")})` }
          } else if (diff.truncated) {
            setCodeVerificationResult(attempt!, "refused", null)
            verify = { command: task.verify, ok: false, exitCode: null, timedOut: false, output: "verification refused because the task diff was truncated" }
          } else {
            startCodeVerification(attempt!)
            const input = await store.snapshot(c.diff_exclude)
            if (!input) { entry.unresolved = true; throw new Error("verifier input snapshot unavailable; queue fenced") }
            const profile = deps.verificationProfile
            const preflight = await deps.verifier.preflight(profile)
            if (!preflight.compatible) {
              setCodeVerificationResult(attempt!, "refused", null)
              verify = { command: task.verify, ok: false, exitCode: null, timedOut: false, output: `verify backend refused: ${preflight.problems.join("; ")}` }
            } else {
              const claim = entry.claim!
              const id = randomUUID()
              const deadlineAt = Date.now() + c.verify_timeout_ms
              const inputDigest = createHash("sha256").update(input.tree).digest("hex")
              let referenceBindingOpen = true
              const request = {
                executionID: id, supervisorSessionID: sessionID, taskID: task.id, attemptID: attempt!.attemptID,
                generation: claim.generation, command: task.verify, cwd: root, inputSnapshotID: input.tree,
                inputDigest, deadlineAt, maxOutputChars: c.verify_output_chars,
                env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1", PYTHONDONTWRITEBYTECODE: "1" }, profile,
                onReference: (reference: VerificationHandle["reference"]) => {
                  if (referenceBindingOpen) deps.runs.bindVerifierRef(claim, id, reference)
                },
              }
              deps.runs.registerIntent(claim, {
                executionId: id, ownerSession: sessionID, taskId: task.id, attemptId: attempt!.attemptID,
                generation: claim.generation, role: "verifier", cwd: root, policyID: "verify-command",
                kind: "verifier", profile, inputSnapshotID: input.tree, inputDigest, deadlineAt, maxOutputChars: c.verify_output_chars,
              })
              entry.preparingExecutionID = id
              const retireUnlaunched = (): void => {
                referenceBindingOpen = false
                try { deps.runs.retireUndispatchedVerifier(claim, id) }
                catch (error) {
                  entry.unresolved = true
                  try { deps.runs.fence(claim, id, "verifier could not be retired before dispatch") } catch {}
                  throw error
                }
              }
              let prepareTimer: ReturnType<typeof setTimeout> | undefined
              const prepareAbort = new Promise<"aborted">(resolve => { entry.cancelWaiter = () => resolve("aborted") })
              let prepared: VerificationHandle | "aborted" | "timeout"
              try {
                prepared = await Promise.race([
                  deps.verifier.prepare(request), prepareAbort,
                  new Promise<"timeout">(resolve => { prepareTimer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineAt - Date.now())) }),
                ])
                if (prepared !== "aborted" && prepared !== "timeout") {
                  request.onReference(prepared.reference)
                  referenceBindingOpen = false
                }
              } catch (error) {
                retireUnlaunched()
                if (entry.aborted) return cancelled()
                throw error
              } finally {
                if (prepareTimer) clearTimeout(prepareTimer)
                entry.preparingExecutionID = undefined
                entry.cancelWaiter = undefined
              }
              if (prepared === "aborted") {
                retireUnlaunched()
                return cancelled()
              }
              if (prepared === "timeout") {
                retireUnlaunched()
                throw new Error("verifier preparation timed out before dispatch")
              }
              if (entry.aborted) {
                retireUnlaunched()
                return cancelled()
              }
              if (Date.now() >= deadlineAt) {
                retireUnlaunched()
                throw new Error("verifier deadline expired before dispatch")
              }
              const handle = prepared
              const current: NonNullable<Active["verify"]> = { id, handle, claim }
              entry.verify = current
              let r: VerificationResult
              try {
                const interrupted = new Promise<"interrupted">(resolve => { entry.cancelWaiter = () => resolve("interrupted") })
                // Persist the possible launch before invoking the handle; do not await between these calls.
                deps.runs.markVerifierDispatched(claim, id)
                current.run = handle.run()
                const result = await Promise.race([current.run, interrupted])
                if (result === "interrupted") {
                  if (!current.cancelled) {
                    deps.runs.fence(claim, id, "verifier cancellation outcome unproven")
                    entry.unresolved = true
                    throw new Error("verifier cancellation unresolved; queue fenced")
                  }
                  r = current.cancelled
                } else r = result
              } catch (error) {
                if (!entry.unresolved) {
                  deps.runs.fence(claim, id, "verifier run failed without terminal evidence")
                  entry.unresolved = true
                }
                throw error
              } finally { entry.verify = undefined; entry.cancelWaiter = undefined }
              if (r.profile !== profile) {
                deps.runs.fence(claim, id, "verifier result profile mismatch")
                entry.unresolved = true
                throw new Error("verifier result profile mismatch; queue fenced")
              }
              const checked = await store.snapshot(c.diff_exclude)
              const changes = await store.diff(input, checked, c.diff_max_chars)
              if (!checked || !changes) {
                entry.unresolved = true
                deps.runs.fence(claim, id, "post-verifier snapshot unavailable")
                throw new Error("post-verifier snapshot unavailable; queue fenced")
              }
              const invalidated = changes.files.length > 0 || r.integrity === "changed"
              const integrity = invalidated ? "changed" : profile === "legacy-unowned" || r.integrity === "unchanged" ? "unchanged" : "unknown"
              r = { ...r, integrity }
              let outcome = "unknown"
              if (r.cancelled) outcome = "killed"
              else if (r.timedOut) outcome = "timeout"
              else if (r.parentExit !== null) outcome = r.parentExit === 0 ? "ok" : "fail"
              try {
                deps.runs.recordTerminal(claim, id, { outcome, terminalAt: Date.now(), verification: r,
                  ...(profile === "linux-single-use" && r.isolationEstablished && r.domainState === "empty" && r.proof ? { quiescentAt: Date.now() } : {}),
                })
                const reconciled = await beforeDeadline(handle.reconcile(), Date.now() + 2000, "verifier reconciliation")
                deps.runs.reconcile(claim, id, { outcome: reconciled.outcome,
                  quiescent: profile === "linux-single-use" && reconciled.outcome === "terminal" && reconciled.isolationEstablished && reconciled.domainState === "empty" && !!reconciled.proof,
                  evidence: "verifier backend reconciliation",
                  ...(profile === "linux-single-use" && reconciled.proof ? { verification: { ...r, proof: reconciled.proof } } : {}),
                })
              } catch (error) {
                deps.runs.fence(claim, id, "verifier terminal reconciliation failed")
                entry.unresolved = true
                throw error
              }
              if (!settled(deps.runs.status().executions.find(execution => execution.executionId === id)!)) {
                deps.runs.fence(claim, id, "verifier terminal/domain settlement unproven")
                entry.unresolved = true
                throw new Error("verifier unsettled; queue fenced")
              }
              if (changes.files.length) {
                let restored: string[]
                try { restored = await store.restore(input, changes.files) }
                catch { entry.unresolved = true; throw new Error("post-verifier restoration failed; queue fenced") }
                if (!changes.files.every(path => restored.includes(path))) {
                  entry.unresolved = true
                  throw new Error("post-verifier restoration incomplete; queue fenced")
                }
              }
              const ok = r.parentExit === 0 && !r.timedOut && !r.cancelled && integrity === "unchanged" &&
                (profile === "legacy-unowned" || strictQuiescent(deps.runs.status().executions.find(execution => execution.executionId === id)!))
              if (ok) verifiedTree = input.tree
              setCodeVerificationResult(attempt!, invalidated ? "invalidated" : r.timedOut ? "timed_out" : r.cancelled ? "aborted" : ok ? "pass" : "fail", r.parentExit)
              verify = { command: task.verify, ok, exitCode: r.parentExit, timedOut: r.timedOut,
                output: invalidated ? "(void: verifier changed files or its post-check snapshot failed)" :
                  r.cancelled ? `(killed: ${entry.reason ?? "aborted"})\n${r.output}` : r.output }
              deps.log("task verify", { sessionID, task: task.id, profile, ok, exitCode: r.parentExit, timedOut: r.timedOut, cancelled: r.cancelled })
            }
          }
          task.verify_result = verify
        } else setCodeVerificationResult(attempt!, "not_run", null)
        if (entry.aborted) return cancelled()
        const verified = !!verify && verify.ok

        // ---- reviewer gate (only when there is something to judge and nothing above already failed)
        let review: ReviewResult = { verdict: "skipped" }
        if (c.review && !diff.truncated && worker.status === "ok" && !report.violations.length && !scan.strong.length && (!verify || verify.ok)) {
          if (!diff || diff.files.length === 0) review = { verdict: "skipped", reason: "no file changes" }
          else review = await runReview(sessionID, entry, task, diff.diff, verify, prot, report.suspicious, scan.weak, c.review_ttl_ms, wt?.path, attempt)
        }
        task.review = review
        attempt!.review = review
        // A reviewer or late writer must not change the content seen by the verifier.
        // Restore the verified tree before retry; merge also rechecks this exact tree.
        if (verifiedTree) {
          const final = await store.snapshot(c.diff_exclude)
          if (!final) { entry.unresolved = true; throw new Error("final verified snapshot unavailable; queue fenced") }
          if (final.tree !== verifiedTree) {
            const trusted = { tree: verifiedTree, store }
            const changed = await store.diff(trusted, final, c.diff_max_chars)
            if (!changed) { entry.unresolved = true; throw new Error("final verified diff unavailable; queue fenced") }
            try {
              const restored = await store.restore(trusted, changed.files)
              if (!changed.files.every(path => restored.includes(path))) throw new Error("incomplete restoration")
            } catch {
              entry.unresolved = true
              throw new Error("final verified tree restoration failed; queue fenced")
            }
            verifiedTree = undefined
            verify = { ...verify!, ok: false, output: "(void: verified tree changed after verification)" }
            task.verify_result = verify
            setCodeVerificationResult(attempt!, "invalidated", verify.exitCode)
          }
        }
        observeWorkflowCancellation(sessionID, entry)
        if (review.aborted || entry.aborted) {
          // a /stop during the review of an already verified change: keep the work, note the missing verdict
          if (!wt && verified && verifiedTree && !report.violations.length && !scan.strong.length && mayComplete(sessionID, entry)) return finishObserved(
            { ...task, status: "done", error: `review aborted (${entry.reason ?? "aborted"})`, finishedAt: Date.now() }, "done")
          return cancelled()
        }

        const lastAttempt = task.attempts >= c.max_attempts
        let failure: string | undefined
        if (diff.truncated) failure = `task diff was truncated at ${c.diff_max_chars} characters; increase delegate.diff_max_chars or split the change into smaller tasks`
        else if (worker.status === "error") failure = `worker error: ${worker.error}`
        else if (report.violations.length) failure = `modified protected file(s): ${report.violations.join(", ")} — they were restored and the verify result does not count; make the code under test pass instead`
        else if (scan.strong.length) failure = `test-gaming pattern in the code: ${scan.strong.join("; ")} — write code that is correct for any input`
        else if (verify && !verify.ok) failure = `verify ${verify.timedOut ? "timed out" : verify.exitCode === null ? "refused" : `failed (exit ${verify.exitCode})`}: ${tail(verify.output, 300)}`
        else if (review.verdict === "reject") {
          // A REJECT on a task whose verify command passed is retried once, then advisory (review_strict: still fails).
          if (!verified || c.review_strict || !lastAttempt) failure = `review rejected: ${review.reason ?? ""}`
        } else if (review.verdict === "error" && c.review_strict) failure = "review gave no verdict"

        if (!failure) {
          const advisory = review.verdict === "reject" ? `accepted with review objection: ${review.reason ?? ""}` : undefined
          if (wt) {
            // accepted: bring the task's changes into the main worktree (in code; a patch that no longer applies is a
            // blocked task, the patch stays with the handoffs for a human)
            let completed: LedgerTask | undefined
            const m = await wt.merge(c.diff_exclude, {
              guard: () => mayComplete(sessionID, entry),
              applied: (files) => {
                task.filesChanged = files
                completed = finishObserved({ ...task, status: "done", error: advisory, finishedAt: Date.now() }, "done")
              },
            }, verifiedTree)
            if (!m.ok) {
              if (m.reason === "task cancelled before merge") return cancelled()
              let kept = m.patch
              try {
                if (!m.patch) throw new Error("no patch was produced")
                const dir = handoffDir(deps.worktree, sessionID)
                mkdirSync(dir, { recursive: true })
                kept = join(dir, `task-${task.n}.patch`)
                copyFileSync(m.patch, kept)
              } catch {}
              deps.log("task worktree merge failed", { sessionID, task: task.id, reason: m.reason, patch: kept })
              return finishObserved(
                { ...task, status: "failed", blocked: m.reason, error: `not merged: ${m.reason} (patch: ${kept})`, finishedAt: Date.now() }, "failed")
            }
            removeWorktree = true
            deps.log("task worktree merged", { sessionID, task: task.id, files: m.files.length })
            return completed!
          }
          if (!mayComplete(sessionID, entry)) return cancelled()
          return finishObserved({ ...task, status: "done", error: advisory, finishedAt: Date.now() }, "done")
        }
        rejectReason = failure
        task = { ...task, error: failure }
        ledger = writeLedger(deps.worktree, updateTask(ledger, task.id, task))
        deps.log("task attempt failed", { sessionID, task: task.id, attempt: task.attempts, failure: oneLine(failure.split("\n")[0] ?? "", 120) })
        // The worker said the task cannot be done honestly and verify agrees: a retry would only waste the slot.
        const noRetry = task.blocked && verify && !verify.ok && !report.violations.length
        const canRetry = !noRetry && task.attempts < c.max_attempts
        finishAttemptObservation(attempt, "failed", canRetry ? "open" : "failed", review)
        previousAttemptID = attempt!.attemptID
        attempt = undefined
        entry.attempt = undefined
        if (noRetry) {
          deps.log("task blocked by worker report, no retry", { sessionID, task: task.id, blocked: task.blocked })
          break
        }
      }
      return finishObserved({ ...task, status: "failed", finishedAt: Date.now() }, "failed")
    } catch (error) {
      finishAttemptObservation(attempt, "failed", "failed", task.review)
      entry.attempt = undefined
      throw error
    } finally {
      if (!wt && !entry.unresolved && !baselineError) store?.dispose()
      if (wt && removeWorktree && !entry.unresolved) {
        try { await wt.remove() }
        catch (error) { deps.log("task worktree cleanup failed", { sessionID, task: task.id, error: String(error) }) }
      }
    }
  }

  /**
   * Data task: analyst child session -> SQL extracted from its text contract -> re-executed + check suite (code-side,
   * the analyst's RESULT block is never trusted) -> data-verifier verdict -> ledger + handoff. No snapshot, no files.
   * Same retry/advisory rules as code tasks: a failed check retries once with the reason; a REJECT after passing
   * checks is advisory on the last attempt unless review_strict.
   */
  async function runDataTask(sessionID: string, entry: Active, task0: LedgerTask, origin?: QueueOrigin): Promise<LedgerTask> {
    const c = cfg()
    let task = task0
    let ledger = readLedger(deps.worktree, sessionID)
    let rejectReason: string | undefined
    let attempt: AttemptObservation | undefined
    let previousAttemptID: string | undefined
    const finishObservedData = (next: LedgerTask, status: "done" | "failed" | "cancelled"): LedgerTask => {
      const done = finish(sessionID, entry, ledger, next)
      finishAttemptObservation(attempt, status, status, done.review, false)
      attempt = undefined
      entry.attempt = undefined
      return done
    }
    const cancelled = (): LedgerTask => finishObservedData(
      { ...task, status: "cancelled", error: entry.reason ?? "aborted", finishedAt: Date.now() }, "cancelled")
    const suiteName = task.verify?.trim() || DEFAULT_SUITE.name
    while (task.attempts < c.max_attempts) {
      observeWorkflowCancellation(sessionID, entry)
      if (entry.aborted) return cancelled()
      task = { ...task, status: "running", attempts: task.attempts + 1, startedAt: task.startedAt ?? Date.now() }
      ledger = writeLedger(deps.worktree, { ...updateTask(ledger, task.id, task), running: { taskId: task.id, since: Date.now() } })
      deps.log("data task start", { sessionID, task: task.id, attempt: task.attempts })
      attempt = createAttempt(sessionID, task, origin, previousAttemptID, false)
      entry.attempt = attempt
      observeTaskStart(attempt)

      const analyst = await runChild(deps, entry, sessionID, "data-analyst", `lca data ${task.n}: ${task.title}`, analystPrompt(ledger, task, rejectReason, c.handoff_context_chars), c.task_ttl_ms, (child) => {
        ledger = writeLedger(deps.worktree, { ...ledger, running: { taskId: task.id, childSessionID: child, since: Date.now() } })
      }, undefined, attempt)
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
          if (!deps.dataChecks) throw new Error("data checks unavailable for this execution runtime")
          check = await deps.dataChecks(parsed.sql, suiteName)
        } catch (e) {
          check = { suite: suiteName, ok: false, results: [], error: `checks could not run: ${(e as Error).message.slice(0, 200)}` }
        }
        const output = check.error && !check.results.length ? check.error : formatCheckRun(check)
        task.verify_result = { command: `data_check ${suiteName}`, ok: check.ok, exitCode: check.ok ? 0 : 1, timedOut: false, output: head(output, c.verify_output_chars) }
        deps.log("data task checks", { sessionID, task: task.id, ok: check.ok, failed: check.results.filter((r) => !r.ok).map((r) => r.name) })
      } else {
        task.verify_result = { command: `data_check ${suiteName}`, ok: false, exitCode: null, timedOut: false, output: task.blocked ? `(not run: analyst reports the data cannot answer: ${task.blocked})` : "(not run: no SQL: block in the analyst's answer)" }
      }
      observeWorkflowCancellation(sessionID, entry)
      if (entry.aborted) return cancelled()
      const verified = !!check?.ok

      // ---- verifier gate: only a checked answer is worth a verdict
      let review: ReviewResult = { verdict: "skipped" }
      if (c.review && analyst.status === "ok" && verified && parsed.sql) {
        review = await runVerify(sessionID, entry, task, parsed.sql, check!, c.review_ttl_ms, attempt!)
      }
      task.review = review
      attempt!.review = review
      observeWorkflowCancellation(sessionID, entry)
      if (review.aborted || entry.aborted) {
        if (verified && mayComplete(sessionID, entry)) return finishObservedData(
          { ...task, status: "done", error: `verification aborted (${entry.reason ?? "aborted"})`, finishedAt: Date.now() }, "done")
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
      } else if (review.verdict === "error" && c.review_strict) failure = `verifier gave no verdict: ${review.reason ?? ""}`

      if (!failure) {
        const advisory = review.verdict === "reject" ? `accepted with verifier objection: ${review.reason ?? ""}` : undefined
        if (!mayComplete(sessionID, entry)) return cancelled()
        return finishObservedData({ ...task, status: "done", error: advisory, finishedAt: Date.now() }, "done")
      }
      rejectReason = failure
      task = { ...task, error: failure }
      ledger = writeLedger(deps.worktree, updateTask(ledger, task.id, task))
      deps.log("data task attempt failed", { sessionID, task: task.id, attempt: task.attempts, failure: oneLine(failure.split("\n")[0] ?? "", 120) })
      if (task.blocked) break
      if (task.attempts < c.max_attempts) {
        finishAttemptObservation(attempt, "failed", "open", review, false)
        previousAttemptID = attempt!.attemptID
        attempt = undefined
        entry.attempt = undefined
      }
    }
    return finishObservedData({ ...task, status: "failed", finishedAt: Date.now() }, "failed")
  }

  async function runVerify(sessionID: string, entry: Active, task: LedgerTask, sql: string, check: CheckRun, ttl: number, attempt: AttemptObservation): Promise<ReviewResult> {
    const r = await runChild(deps, entry, sessionID, "data-verifier", `lca verify ${task.n}: ${task.title}`, verifierPrompt(task, sql, check), ttl, undefined, undefined, attempt)
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
    if (!entry.unresolved) {
      for (const child of done.childSessions) removeSessionDir(deps.worktree, child)
      if (done.review?.sessionID) removeSessionDir(deps.worktree, done.review.sessionID)
    }
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
    attempt?: AttemptObservation,
  ): Promise<ReviewResult> {
    const r = await runChild(deps, entry, sessionID, "reviewer", `lca review ${task.n}: ${task.title}`, reviewerPrompt(task, diff, verify, prot, suspicious, hints), ttl, undefined, directory, attempt)
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
  if (task.verify) lines.push(`The framework will run this verification after your edits; do not run it: ${task.verify}`)
  const prot = protectedFiles(task)
  if (prot.length) lines.push(`Never edit ${prot.join(", ")}. If the check cannot pass with honest code, report that under Open issues.`)
  const ctx = handoffContext(ledger, task.id, contextChars)
  if (ctx) lines.push("", ctx)
  if (previousFailure) {
    lines.push(
      "",
      `A previous worker already changed files for this task, but the result was not accepted. Reason: ${oneLine(previousFailure, 300)}`,
      "Read the files first and keep what already works. Change only the code this task owns to satisfy the declared verification; the framework runs it after your edits. Never invoke Bash or run tests, and never edit test files. If it cannot pass honestly, explain under Open issues and stop.",
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

async function runChild(
  deps: ExecutionRuntime,
  entry: Active,
  parentID: string,
  agent: LcaAgentName,
  title: string,
  text: string,
  ttlMs: number,
  onCreated?: (sessionID: string) => void,
  directory?: string,
  attempt?: AttemptObservation,
): Promise<ChildRun> {
  if (entry.aborted) return { status: "aborted" }
  const claim = entry.claim!
  const executionID = randomUUID()
  const attemptID = attempt?.attemptID ?? randomUUID()
  const policy = deps.policy.resolve(agent as ExecutionRole)
  const request = {
    executionID, supervisorSessionID: parentID, taskID: attempt?.taskID ?? executionID,
    attemptID, generation: claim.generation, role: agent as ExecutionRole,
    title, cwd: directory ?? deps.directory, text, deadlineAt: Date.now() + ttlMs, policy,
  }
  const fullRequest = {
    ...request, handlers: deps.policy.handlers(request),
    onReference: (reference: ExecutionReference) => deps.runs.bindVendorRef(claim, executionID, JSON.stringify(reference)),
  }
  deps.runs.registerIntent(claim, {
    executionId: executionID, ownerSession: parentID, taskId: request.taskID,
    attemptId: attemptID, generation: claim.generation, role: agent, cwd: request.cwd, policyID: policy.id,
    kind: "host", profile: "legacy-unowned",
  })
  entry.preparingExecutionID = executionID
  let handle: ExecutionHandle
  let prepareTimer: ReturnType<typeof setTimeout> | undefined
  const prepareAbort = new Promise<"aborted">((resolve) => { entry.cancelWaiter = () => resolve("aborted") })
  try {
    const prepared = await Promise.race([
      deps.host.prepare(fullRequest), prepareAbort,
      new Promise<"timeout">((resolve) => { prepareTimer = setTimeout(() => resolve("timeout"), Math.max(0, request.deadlineAt - Date.now())) }),
    ])
    if (prepared === "aborted" || prepared === "timeout") throw new Error(`child preparation ${prepared} without terminal quiescence`)
    handle = prepared
    deps.runs.bindVendorRef(claim, executionID, JSON.stringify(handle.reference))
  } catch (error) {
    deps.runs.fence(claim, executionID, "prepare failed without proof of quiescence")
    entry.unresolved = true
    throw error
  } finally {
    if (prepareTimer) clearTimeout(prepareTimer)
    entry.preparingExecutionID = undefined
    entry.cancelWaiter = undefined
  }
  const sessionID = handle.reference.vendorSessionID
  entry.child = { id: executionID, handle, claim }
  if (attempt && sessionID) observeChild(deps, attempt, sessionID, agent, "started")
  const complete = (run: ChildRun): ChildRun => {
    if (attempt && sessionID) observeChild(deps, attempt, sessionID, agent,
      run.status === "ok" ? "done" : run.status === "error" ? "failed" : "cancelled")
    return run
  }
  try {
    if (sessionID) onCreated?.(sessionID)
  } catch (error) {
    deps.runs.fence(claim, executionID, "child registration failed")
    entry.unresolved = true
    throw error
  }
  // The prepared handle is inert. Cancellation before dispatch is recorded as quiescent.
  if (entry.aborted) {
    deps.runs.recordTerminal(claim, executionID, { outcome: "cancelled", terminalAt: Date.now(), quiescentAt: Date.now() })
    entry.child = undefined
    if (sessionID) deps.policy.unbindSession(sessionID)
    return complete({ status: "aborted", sessionID })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, request.deadlineAt - Date.now()))
  })
  const cancelled = new Promise<"cancelled">((resolve) => {
    entry.cancelWaiter = () => resolve("cancelled")
  })
  try {
    const raced = await Promise.race([handle.run(), timeout, cancelled])
    if (raced === "cancelled") {
      try { deps.runs.assertQuiescent(claim) }
      catch { entry.unresolved = true; throw new Error("child cancellation ended without terminal quiescence; queue fenced") }
      return complete({ status: "aborted", sessionID })
    }
    if (raced === "timeout") {
      await cancelChild(deps, { id: executionID, handle, claim }, "child timeout")
      try { deps.runs.assertQuiescent(claim) }
      catch { entry.unresolved = true; throw new Error(`child execution timed out without quiescence after ${Math.round(ttlMs / 1000)}s`) }
      return complete({ status: "error", sessionID, error: `child session timed out after ${Math.round(ttlMs / 1000)}s` })
    }
    const res = raced
    const terminal = res.status === "completed" || res.status === "failed" || res.status === "cancelled"
    if (terminal) deps.runs.recordTerminal(claim, executionID, { outcome: res.status, terminalAt: Date.now() })
    const reconciled = await handle.reconcile()
    deps.runs.reconcile(claim, executionID, reconciled)
    if (!terminal || !reconciled.quiescent || reconciled.outcome !== "terminal") {
      deps.runs.fence(claim, executionID, "execution terminal/quiescence unproven")
      entry.unresolved = true
      throw new Error("child execution unresolved; queue fenced")
    }
    if (entry.aborted) return complete({ status: "aborted", sessionID })
    if (res.status !== "completed") return complete({ status: "error", sessionID, error: res.error ?? res.status, text: res.text })
    return complete({ status: "ok", sessionID, text: res.text })
  } catch (error) {
    if (entry.unresolved) throw error
    deps.runs.fence(claim, executionID, "execution threw without terminal/quiescence proof")
    entry.unresolved = true
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    entry.cancelWaiter = undefined
    if (entry.child?.id === executionID) entry.child = undefined
    if (!entry.unresolved && sessionID) deps.policy.unbindSession(sessionID)
  }
}

async function cancelChild(deps: ExecutionRuntime, child: { id: string; handle: ExecutionHandle; claim: ExecutionClaim }, reason: string): Promise<void> {
  const deadlineAt = Date.now() + 2000
  deps.runs.recordCancel(child.claim, child.id, { requestedAt: Date.now() })
  try {
    const cancellation = await Promise.race([
      child.handle.requestCancel(reason, deadlineAt),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadlineAt - Date.now()))),
    ])
    if (cancellation?.acknowledged) deps.runs.recordCancel(child.claim, child.id, { requestedAt: Date.now(), acknowledgedAt: Date.now() })
    const reconciliation = await Promise.race([
      child.handle.reconcile(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadlineAt - Date.now()))),
    ])
    if (reconciliation) deps.runs.reconcile(child.claim, child.id, reconciliation)
    if (!reconciliation?.quiescent || reconciliation.outcome !== "terminal") deps.runs.fence(child.claim, child.id, "cancellation acknowledged without terminal quiescence")
  } catch (error) {
    deps.runs.fence(child.claim, child.id, "cancellation failed without terminal quiescence")
    deps.log("child abort failed", { executionID: child.id, error: String(error) })
  }
}
