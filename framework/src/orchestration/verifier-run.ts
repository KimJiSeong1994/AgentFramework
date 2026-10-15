// Shared verifier execution sequence (P6b S1), extracted from the serial queue without behavior change. The queue and
// the experiment runner both run an allow-listed command through the VerificationExecutor with the same ordering:
// durable intent -> prepare (retire if unlaunched) -> markVerifierDispatched -> run -> terminal record -> reconcile ->
// settlement proof -> post-run integrity diff and restoration. Any unproven step fences the claim and throws.
import { createHash, randomUUID } from "node:crypto"
import { authenticateLinuxVerification } from "../hosts/linux-domain.ts"
import { settled, strictQuiescent, type ExecutionClaim } from "../hosts/run-state.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import type { Snapshot, SnapshotStore } from "./snapshot.ts"
import type { VerificationHandle, VerificationResult } from "./verifier.ts"

const WORKFLOW_STOP_CAUSE = /^workflow_(pause|cancel):/
export const UNSETTLED_REASON = "verifier terminal/domain settlement unproven"

export async function beforeDeadline<T>(work: Promise<T>, deadlineAt: number, label: string): Promise<T> {
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

/** The mutable run state a verifier execution shares with its abort path (the queue's `Active` entry satisfies it). */
export type VerifierRunEntry = {
  aborted: boolean
  reason?: string
  claim?: ExecutionClaim
  unresolved?: boolean
  preparingExecutionID?: string
  cancelWaiter?: () => void
  verify?: { id: string; handle: VerificationHandle; claim: ExecutionClaim; run?: Promise<VerificationResult>; cancelled?: VerificationResult }
}

export type VerifierRunParams = {
  sessionID: string
  taskID: string
  attemptID: string
  attemptNumber: number
  command: string
  /** cwd the command runs in */
  root: string
  store: SnapshotStore
  config: { diff_exclude: string[]; diff_max_chars: number; verify_timeout_ms: number; verify_output_chars: number }
}

export type VerifierRunOutcome =
  | { kind: "cancelled" }
  | { kind: "refused"; output: string }
  /**
   * The command ran to a terminal result but the execution could not be proven settled (e.g. a legacy parent-shell
   * verifier that timed out or was killed: descendants are unobservable). The claim stays fenced and `entry.unresolved`
   * is set; the terminal result is returned so the caller can record what actually happened. Callers that cannot
   * continue past a fence (the queue) treat this as the fenced error it always was.
   */
  | { kind: "unresolved"; r: VerificationResult; profile: VerificationResult["profile"]; id: string; reason: string }
  | { kind: "ran"; r: VerificationResult; profile: VerificationResult["profile"]; id: string; input: NonNullable<Snapshot>; changes: { files: string[] }; invalidated: boolean; integrity: "changed" | "unchanged" | "unknown"; ok: boolean }

export async function runVerifierExecution(deps: ExecutionRuntime, entry: VerifierRunEntry, params: VerifierRunParams): Promise<VerifierRunOutcome> {
  const { sessionID, taskID, attemptID, attemptNumber, command, root, store, config } = params
    const input = await store.snapshot(config.diff_exclude)
    if (!input) { entry.unresolved = true; throw new Error("verifier input snapshot unavailable; queue fenced") }
    const profile = deps.verificationProfile
    const preflight = await deps.verifier.preflight(profile)
  if (!preflight.compatible) return { kind: "refused", output: `verify backend refused: ${preflight.problems.join("; ")}` }
  const claim = entry.claim!
  const id = randomUUID()
  const deadlineAt = Date.now() + config.verify_timeout_ms
  const inputDigest = createHash("sha256").update(input.tree).digest("hex")
  let referenceBindingOpen = true
  const request = {
    executionID: id, supervisorSessionID: sessionID, taskID: taskID, attemptID: attemptID,
    generation: claim.generation, command: command, cwd: root, inputSnapshotID: input.tree,
    inputDigest, deadlineAt, maxOutputChars: config.verify_output_chars,
    env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1", PYTHONDONTWRITEBYTECODE: "1" }, profile,
    onReference: (reference: VerificationHandle["reference"]) => {
      if (referenceBindingOpen) deps.runs.bindVerifierRef(claim, id, reference)
    },
  }
  deps.runs.registerIntent(claim, {
    executionId: id, ownerSession: sessionID, taskId: taskID, attemptId: attemptID,
    generation: claim.generation, role: "verifier", cwd: root, policyID: "verify-command",
    kind: "verifier", profile, inputSnapshotID: input.tree, inputDigest, deadlineAt, maxOutputChars: config.verify_output_chars,
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
      (async () => {
        const inputArchive = profile === "linux-single-use" ? await store.archive(input) : undefined
        if (profile === "linux-single-use" && !inputArchive) throw new Error("owned verifier input archive unavailable")
        if (!referenceBindingOpen || entry.aborted || Date.now() >= deadlineAt) throw new Error("verifier preparation retired before dispatch")
        return deps.verifier.prepare({ ...request, ...(inputArchive ? { inputArchive } : {}) })
      })(), prepareAbort,
      new Promise<"timeout">(resolve => { prepareTimer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineAt - Date.now())) }),
    ])
    if (prepared !== "aborted" && prepared !== "timeout") {
      request.onReference(prepared.reference)
      referenceBindingOpen = false
    }
  } catch (error) {
    retireUnlaunched()
    if (entry.aborted) return { kind: "cancelled" }
    throw error
  } finally {
    if (prepareTimer) clearTimeout(prepareTimer)
    entry.preparingExecutionID = undefined
    entry.cancelWaiter = undefined
  }
  if (prepared === "aborted") {
    retireUnlaunched()
    return { kind: "cancelled" }
  }
  if (prepared === "timeout") {
    retireUnlaunched()
    throw new Error("verifier preparation timed out before dispatch")
  }
  if (entry.aborted) {
    retireUnlaunched()
    return { kind: "cancelled" }
  }
  if (Date.now() >= deadlineAt) {
    retireUnlaunched()
    throw new Error("verifier deadline expired before dispatch")
  }
  const handle = prepared
  const current: NonNullable<VerifierRunEntry["verify"]> = { id, handle, claim }
  entry.verify = current
  let r: VerificationResult
  try {
    const interrupted = new Promise<"interrupted">(resolve => { entry.cancelWaiter = () => resolve("interrupted") })
    // Persist the possible launch before invoking the handle; do not await between these calls.
    deps.runs.markVerifierDispatched(claim, id)
    current.run = handle.run()
    try {
      deps.log("task verify started", { sessionID, task: taskID, attempt: attemptNumber })
    } catch { /* Progress observation must not change verifier execution. */ }
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
  if (profile === "linux-single-use" && !authenticateLinuxVerification(r, handle.reference)) {
    deps.runs.fence(claim, id, "owned verifier retirement is not authenticated")
    entry.unresolved = true
    throw new Error("owned verifier retirement is not authenticated; queue fenced")
  }
  const checked = await store.snapshot(config.diff_exclude)
  const changes = await store.diff(input, checked, config.diff_max_chars)
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
      ...(profile === "linux-single-use" && authenticateLinuxVerification(r, handle.reference) ? { quiescentAt: Date.now() } : {}),
    })
    const reconciled = await beforeDeadline(handle.reconcile(), Date.now() + 2000, "verifier reconciliation")
    const authenticated = profile === "linux-single-use" && reconciled.outcome === "terminal" &&
      !!reconciled.result && authenticateLinuxVerification(reconciled.result, handle.reference) &&
      reconciled.result.proof?.receipt === r.proof?.receipt &&
      reconciled.result.proof?.signature === r.proof?.signature
    if (profile === "linux-single-use" && !authenticated) throw new Error("owned verifier final reconciliation is not authenticated")
    deps.runs.reconcile(claim, id, { outcome: reconciled.outcome,
      quiescent: authenticated,
      evidence: "verifier backend reconciliation",
      ...(authenticated ? { verification: r } : {}),
    })
  } catch (error) {
    deps.runs.fence(claim, id, "verifier terminal reconciliation failed")
    entry.unresolved = true
    throw error
  }
  if (!settled(deps.runs.status().executions.find(execution => execution.executionId === id)!)) {
    deps.runs.fence(claim, id, "verifier terminal/domain settlement unproven")
    entry.unresolved = true
    return { kind: "unresolved", r, profile, id, reason: UNSETTLED_REASON }
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
  return { kind: "ran", r, profile, id, input, changes, invalidated, integrity, ok }
}

/**
 * The cancellation half of a verifier execution, shared by the queue's abort and the experiment runner. An in-flight
 * verifier is asked to cancel (recorded, 2s bound); an unacknowledged request with no terminal outcome fences the claim
 * and marks the entry unresolved. A run still preparing is recorded as cancelled and its preparation is woken so it is
 * retired without dispatch. Callers set `entry.aborted`/`entry.reason` first.
 */
export async function abortVerifierExecution(deps: ExecutionRuntime, entry: VerifierRunEntry, reason: string): Promise<void> {
  // One policy for the queue and the experiment runner: a workflow pause/cancel never kills a RUNNING legacy (parent-shell)
  // verifier. Its cancellation can never be acknowledged as family proof, so a kill would only leave a permanent fence;
  // the command is left to exit or hit its verify deadline (the stop stays "pausing" until then) and the caller sees
  // `entry.aborted`. The cancel waiter is NOT woken: it would turn a still-running command into an unproven cancellation.
  // Other aborts (session end, explicit user stop marker, queue ttl) keep the kill-and-fence behaviour.
  if (entry.verify && deps.verificationProfile === "legacy-unowned" && WORKFLOW_STOP_CAUSE.test(reason)) return
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
  if (entry.claim && entry.preparingExecutionID) deps.runs.recordCancel(entry.claim, entry.preparingExecutionID, { requestedAt: Date.now() })
  entry.cancelWaiter?.()
}
