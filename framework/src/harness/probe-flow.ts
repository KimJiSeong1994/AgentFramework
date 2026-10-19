// Same-task probe flow (S1): propose -> (typed approval, see probe.ts) -> run -> show -> apply | discard.
// Hosts: scripts/otter-probe.ts. Nothing here approves, merges or adopts anything by itself:
//   - proposer turns are read-only workflow turns that return only overlay TEXT (task data);
//   - a probe runs only after a receipt bound to the exact subject sha, each in its own isolated worktree
//     (scope probe-<wid>-<label>), through the ordinary queue with the probe origin (no merge, no in-place fallback,
//     one attempt, no earlier-task handoff) and the framework verifier (verify_allow);
//   - the checkout stays byte-identical until a human runs `apply` for one label.
import { createHash, randomUUID } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import type { OtterConfig } from "../config.ts"
import { assertHostAdmission } from "../hosts/required-controls.ts"
import { createExecutionRunStore, settled } from "../hosts/run-state.ts"
import { EXECUTION_ROLES, type ComboRoutes, type ExecutionRuntime } from "../hosts/types.ts"
import { scanDiff } from "../orchestration/gaming.ts"
import { safeGit } from "../orchestration/git-boundary.ts"
import { createQueue } from "../orchestration/queue.ts"
import { createSnapshotStore } from "../orchestration/snapshot.ts"
import { createTaskWorktree, hasTaskWorktreeState, planIsolationAvailability, reopenTaskWorktree, worktreeRoot, type TaskWorktree } from "../orchestration/worktree.ts"
import { protectedFiles, readLedger, head as headChars } from "../state/ledger.ts"
import { stateRoot } from "../state/store.ts"
import { PROBE_DOM_PROMPT, PROBE_INV_PROMPT } from "../workflows/prompts/probe.ts"
import { definePrompt, type StagePrompt } from "../workflows/prompts/prompt.ts"
import { runWorkflowTurn, type TurnBinding } from "../workflows/turn.ts"
import { PROBE_REFLECT_PROMPT } from "../workflows/prompts/probe-reflect.ts"
import { admitLesson, appendLesson, classifyRows, parseReflection } from "./lessons.ts"
import { harnessProfile } from "./profile.ts"
import {
  APPROVAL_ACTION, DIMENSIONS, PROBE_LIMITS, SUBJECT_SCHEMA, assertLabel, assertSubjectBody, assertTaskInput, checkOverlay, classifyProbe, loadSubject,
  overlayOf, parseOverlayReply, probeLabels, probeScope, probeSession, probeSubjectSha, probeTaskDetail, readProbeRun, readProbeRuns, sanitizeTail,
  verifyApproval, writeProbeRun, writeProposals, writeSubject, type OverlayDimension, type ProbeSubject, type SubjectBody,
} from "./probe.ts"
import type { ProbeLabel, ProbeRun } from "./types.ts"

const TURN_BUDGET = Object.freeze({ maxChars: 24_000, reserveChars: 8_000 })
const LESSON_TEXT_CHARS = 4_000
const PATCH_SCAN_BYTES = 2 * 1024 * 1024

export type ProbeRoutes = { engine: string; model: string; combo: ComboRoutes }

/** One read-only proposer/reflector turn on the kind/stage/role this framework already schedules for researcher turns. */
export async function runProbeTurn(runtime: ExecutionRuntime, input: { sessionID: string; prompt: StagePrompt; text: string; title: string; signal?: AbortSignal }): Promise<string> {
  const binding: TurnBinding = {
    workflowID: null, revision: null, kind: "autoresearch", stage: "hypothesis", role: "researcher", prompt: input.prompt,
    supervisorSessionID: input.sessionID, epoch: null, ownerInstance: null,
  }
  const result = await runWorkflowTurn(runtime, binding, {
    title: input.title, text: input.text, label: "probe", cancelCause: "probe turn cancelled", budget: TURN_BUDGET,
  }, input.signal)
  if (result.status === "diagnostic") throw new Error(`probe turn superseded: ${result.reason}`)
  if (result.status === "stuck") throw new Error(result.reason)
  return result.text
}

/** HEAD and the working-tree snapshot (tracked + untracked, excludes applied) of the checkout. Read-only. */
export async function mainState(worktree: string, config: Readonly<OtterConfig>): Promise<{ head: string; tree: string }> {
  const availability = await planIsolationAvailability(worktree)
  if (availability !== "ready") throw new Error(`probe refused: ${availability === "no-git" ? "not a git repository" : "the repository has no commit"}; probes run only in isolated worktrees, there is no in-place fallback`)
  const head = await safeGit(worktree, ["rev-parse", "HEAD"])
  if (!head) throw new Error("probe refused: could not resolve HEAD")
  const store = await createSnapshotStore(worktree)
  if (!store) throw new Error("probe refused: could not snapshot the checkout")
  try {
    const snapshot = await store.snapshot(config.delegate.diff_exclude)
    if (!snapshot) throw new Error("probe refused: could not snapshot the checkout")
    return { head, tree: snapshot.tree }
  } finally { store.dispose() }
}

function proposerText(prompt: StagePrompt, task: SubjectBody["task"], lessons: string): string {
  const reference = lessons.trim()
  if (reference.length > LESSON_TEXT_CHARS) throw new Error("probe lessons reference exceeds its bound")
  return `${prompt.text}title: ${task.title}\ndetail: ${task.detail || "(none)"}\nverification command (the framework runs it after the worker's edits): ${task.verify}${reference ? `\n\n${reference}` : ""}\n`
}

export type ProposalRecord = { dimension: OverlayDimension; status: "overlay" | "keep_base" | "invalid"; reason?: string; overlaySha?: string }
export type ProposeResult = { wid: string; proposals: ProposalRecord[]; subject?: ProbeSubject }

/**
 * Two read-only proposer turns (INV, then DOM). Invalid replies are recorded and skipped; KEEP_BASE spends no probe. A subject
 * exists only when at least one overlay survives validation. Nothing is executed.
 */
export async function proposeProbe(
  runtime: ExecutionRuntime,
  input: { title: string; detail: string; verify: string; k: number; routes: ProbeRoutes; lessons?: string; wid?: string; signal?: AbortSignal },
): Promise<ProposeResult> {
  const worktree = runtime.worktree
  const wid = input.wid ?? `pr_${randomUUID().replace(/-/g, "").slice(0, 10)}`
  const task = { title: input.title.trim(), detail: input.detail.trim(), verify: input.verify.trim() }
  assertTaskInput(task, runtime.config)
  if (!Number.isInteger(input.k) || input.k < 1 || input.k > PROBE_LIMITS.maxK) throw new Error(`probe k must be an integer from 1 to ${PROBE_LIMITS.maxK}`)
  const state = await mainState(worktree, runtime.config)
  const profile = await harnessProfile(runtime.config, worktree)
  const sessionID = probeSession(wid)
  const overlays: SubjectBody["overlays"] = { inv: null, dom: null }
  const proposals: ProposalRecord[] = []
  const prompts: Record<OverlayDimension, StagePrompt> = { inv: PROBE_INV_PROMPT, dom: PROBE_DOM_PROMPT }
  for (const dimension of DIMENSIONS) {
    const reply = await runProbeTurn(runtime, {
      sessionID, prompt: prompts[dimension], text: proposerText(prompts[dimension], task, input.lessons ?? ""), title: `otter probe ${dimension} proposal`, signal: input.signal,
    })
    const parsed = parseOverlayReply(reply, dimension)
    if (parsed.status === "invalid") { proposals.push({ dimension, status: "invalid", reason: parsed.reason }); continue }
    if (parsed.status === "keep_base") { proposals.push({ dimension, status: "keep_base" }); continue }
    const checked = checkOverlay(parsed.text, task)
    if (checked.status === "invalid") proposals.push({ dimension, status: "invalid", reason: checked.reason })
    else if (checked.status === "keep_base") proposals.push({ dimension, status: "keep_base" })
    else { overlays[dimension] = checked.text; proposals.push({ dimension, status: "overlay", overlaySha: checked.sha }) }
  }
  writeProposals(worktree, wid, { schema: "otter.probe-proposals.v1", wid, proposals })
  if (overlays.inv === null && overlays.dom === null) return { wid, proposals }
  const body: SubjectBody = {
    schema: SUBJECT_SCHEMA, task, overlays, head: state.head, baseTree: state.tree, profileFingerprint: profile.fingerprint, k: input.k, routes: input.routes,
  }
  assertSubjectBody(body, runtime.config)
  const subject: ProbeSubject = { wid, sid: sessionID, sha: probeSubjectSha(body), body }
  writeSubject(worktree, subject)
  return { wid, proposals, subject }
}

type RunOptions = { signal?: AbortSignal; onRun?: (run: ProbeRun) => void }

function policyIDs(runtime: ExecutionRuntime): Record<string, string> {
  return Object.fromEntries(EXECUTION_ROLES.map(role => [role, runtime.policy.resolve(role).id]))
}

function readPatch(path: string): string | null {
  if (!path) return ""
  try {
    if (statSync(path).size > PATCH_SCAN_BYTES) return null
    return readFileSync(path, "utf8")
  } catch { return null }
}

/**
 * Run every not-yet-recorded probe of an APPROVED subject, sequentially. Refuses (before any dispatch) when the approval
 * receipt does not match the subject's current sha, the profile fingerprint, HEAD or working tree changed, or the verify
 * command is no longer admissible. A refusal between probes keeps the probes already recorded.
 */
export async function runProbes(runtime: ExecutionRuntime, wid: string, options: RunOptions = {}): Promise<ProbeRun[]> {
  const worktree = runtime.worktree
  const subject = loadSubject(worktree, wid)
  assertSubjectBody(subject.body, runtime.config)
  const approval = verifyApproval(worktree, subject)
  if (!approval.ok) throw new Error(`probe run refused: ${approval.reason}`)
  const profile = await harnessProfile(runtime.config, worktree)
  if (profile.fingerprint !== subject.body.profileFingerprint) throw new Error("probe run refused: the harness profile changed since approval (skills, roles or config)")
  const routes = subject.body.routes as ProbeRoutes
  if (runtime.host.identity.engine !== routes.engine) throw new Error("probe run refused: the host engine differs from the approved subject")
  assertHostAdmission(await runtime.host.preflight(runtime.host.identity.profile), runtime.host.identity.controlProfile)
  const ids = policyIDs(runtime)
  const runs: ProbeRun[] = []
  for (const label of probeLabels(subject.body)) {
    const recorded = readProbeRun(worktree, wid, label)
    if (recorded) { runs.push(recorded); continue }
    if (options.signal?.aborted) throw new Error("probe run interrupted")
    const run = await runOne(runtime, subject, label, ids, options)
    runs.push(run)
    options.onRun?.(run)
    if (run.invalid === "unsettled") throw new Error(`probe ${label} ended unsettled; the claim stays fenced and later probes are not started`)
  }
  return runs
}

async function runOne(runtime: ExecutionRuntime, subject: ProbeSubject, label: ProbeLabel, ids: Record<string, string>, options: RunOptions): Promise<ProbeRun> {
  assertLabel(label)
  const worktree = runtime.worktree
  const { body, wid, sid } = subject
  const config = runtime.config
  const exclude = config.delegate.diff_exclude
  const state = await mainState(worktree, config)
  if (state.head !== body.head) throw new Error(`probe ${label} refused: HEAD changed since the subject was proposed`)
  if (state.tree !== body.baseTree) throw new Error(`probe ${label} refused: the working tree changed since the subject was proposed`)
  const scope = probeScope(wid, label)
  if (hasTaskWorktreeState(worktree, sid, scope)) throw new Error(`probe ${label} refused: a worktree for it exists without a record; discard the probe workflow first`)
  const wt = await createTaskWorktree(worktree, sid, scope, exclude)
  if (!wt) throw new Error(`probe ${label} refused: the repository has no commit; there is no in-place fallback`)
  if (wt.baseline.tree !== body.baseTree) {
    await wt.remove()
    throw new Error(`probe ${label} refused: the isolated baseline differs from the recorded base tree (an imported untracked file may have changed mode); no probe was run`)
  }
  const { overlay, text } = overlayOf(body, label)
  const detail = probeTaskDetail(body.task.detail, text, overlay === "none" ? null : overlay)
  const queue = createQueue(runtime)
  const [added] = queue.add(sid, [{ title: body.task.title, detail, verify: body.task.verify }])
  const onAbort = () => { void queue.abort(sid, "probe interrupted").catch(() => {}) }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const started = Date.now()
  let result
  try { result = await queue.run(sid, { planWorktree: wt, probe: { scope, baseTree: body.baseTree } }) }
  finally { options.signal?.removeEventListener("abort", onAbort) }
  const durationMs = Date.now() - started
  const task = readLedger(worktree, sid).tasks.find(candidate => candidate.id === added!.id)
  if (result.skipped) throw new Error(`probe ${label} refused: another execution owns this checkout (${result.skipped})`)
  if (!task || task.status === "pending") {
    // Nothing ran (queue-level refusal before dispatch): the worktree is untouched, so it is safe to remove and retry.
    if (!result.refused) {
      queue.cancelOpen(sid, "probe did not start")
      try { await wt.remove() } catch { /* the preserved worktree is reported by discard */ }
      throw new Error(`probe ${label} did not start: ${result.abortReason ?? "queue refused"}`)
    }
  }
  const verify = task?.verify_result
  const unsettled = result.aborted && /unsettled|fenced|unresolved/.test(result.abortReason ?? "")
  const interrupted = (result.aborted && !unsettled) || task?.status === "cancelled"
  const refused = !!result.refused || (!!verify && verify.exitCode === null && !verify.timedOut && !verify.ok && !verify.output.startsWith("(void:"))
  let integrity = !!verify && verify.output.startsWith("(void:")
  let resultTree: string | null = null
  let diffStat = ""
  if (!unsettled && !interrupted && !result.refused) {
    const preview = await wt.preview(exclude)
    if (!preview.ok) integrity = true
    else {
      diffStat = headChars(preview.stat, PROBE_LIMITS.diffStatChars)
      const after = await wt.store.snapshot(exclude)
      if (!after) integrity = true
      else resultTree = after.tree
      // A strong test-gaming shape in the diff invalidates the contrast exactly as it fails a normal task attempt.
      const patch = readPatch(preview.patch)
      if (patch === null || scanDiff(patch, protectedFiles({ verify: body.task.verify })).strong.length) integrity = true
    }
  }
  const verifyRecord = verify
    ? { ok: verify.ok, exitCode: verify.exitCode, timedOut: verify.timedOut, outputTail: sanitizeTail(verify.output, [worktree, wt.path, stateRoot(worktree), worktreeRoot(worktree)], config.delegate.verify_output_chars) }
    : null
  const classified = classifyProbe({ unsettled, interrupted, refused, integrity, verify: verifyRecord })
  const run: ProbeRun = {
    schema: "otter.probe-run.v1", probeWid: wid, label, overlay, overlaySha: text === null ? null : sha(text),
    policyIDs: ids, baseTree: body.baseTree, resultTree, verify: verifyRecord, diffStat, durationMs,
    valid: classified.valid, ...(classified.invalid ? { invalid: classified.invalid } : {}),
  }
  writeProbeRun(worktree, run)
  return run
}

function sha(text: string): string { return createHash("sha256").update(text).digest("hex") }

// ------------------------------------------------------------------------------------------------ human decisions
export type ProbeHost = { worktree: string; config: Readonly<OtterConfig> }

export function showProbe(worktree: string, wid: string): { subject: ProbeSubject; approved: boolean; runs: ProbeRun[] } {
  const subject = loadSubject(worktree, wid)
  return { subject, approved: verifyApproval(worktree, subject).ok, runs: readProbeRuns(worktree, subject) }
}

export type ApplyResult = { ok: true; label: ProbeLabel; files: string[] } | { ok: false; label: ProbeLabel; reason: string; patch?: string }

/**
 * Apply exactly one probe's diff to the checkout, then remove that probe's worktree (plan-worktree Apply). Refuses a probe that
 * is invalid or whose deterministic verify did not pass, and a worktree that changed since its result was recorded.
 */
export async function applyProbe(host: ProbeHost, wid: string, label: ProbeLabel): Promise<ApplyResult> {
  assertLabel(label)
  const subject = loadSubject(host.worktree, wid)
  const run = readProbeRun(host.worktree, wid, label)
  if (!probeLabels(subject.body).includes(label)) return { ok: false, label, reason: "unknown probe label for this subject" }
  if (!run) return { ok: false, label, reason: "no recorded run for this label" }
  if (!run.valid) return { ok: false, label, reason: `the run is invalid (${run.invalid ?? "unknown"}); only a valid run with a passing verify can be applied` }
  if (!run.verify?.ok || run.resultTree === null) return { ok: false, label, reason: "the run's verify did not pass; only a passing run can be applied" }
  if (createExecutionRunStore(host.worktree).status().executions.some(execution => !settled(execution))) {
    return { ok: false, label, reason: "an execution is unresolved; the probe worktree stays untouched" }
  }
  const wt = await reopenProbe(host, subject, label)
  const merged = await wt.merge(host.config.delegate.diff_exclude, undefined, run.resultTree)
  if (!merged.ok) return { ok: false, label, reason: merged.reason, ...(merged.patch ? { patch: merged.patch } : {}) }
  await wt.remove()
  return { ok: true, label, files: merged.files }
}

/** Remove every remaining probe worktree of the workflow. Records stay as evidence. */
export async function discardProbes(host: ProbeHost, wid: string): Promise<ProbeLabel[]> {
  const subject = loadSubject(host.worktree, wid)
  const removed: ProbeLabel[] = []
  for (const label of probeLabels(subject.body)) {
    if (!hasTaskWorktreeState(host.worktree, subject.sid, probeScope(wid, label))) continue
    const wt = await reopenProbe(host, subject, label)
    await wt.remove()
    removed.push(label)
  }
  return removed
}

function reopenProbe(host: ProbeHost, subject: ProbeSubject, label: ProbeLabel): Promise<TaskWorktree> {
  return reopenTaskWorktree(host.worktree, subject.sid, probeScope(subject.wid, label), host.config.delegate.diff_exclude)
}

export { APPROVAL_ACTION }

// ------------------------------------------------------------------------------------------------ lessons (S3 call site)
const REFLECT_STAGE_PROMPT = definePrompt({ id: PROBE_REFLECT_PROMPT.id, kind: "autoresearch", role: "researcher", text: PROBE_REFLECT_PROMPT.text })

/**
 * After a probe workflow: one read-only reflector turn over rows that CODE classified (lessons.ts classifyRows). Admission and
 * the append are code; a reply that cites anything but helped/hurt rows of one component is NO_ENTRY. Never throws for a
 * refused lesson: the probe records are already durable.
 */
export async function reflectProbes(runtime: ExecutionRuntime, subject: ProbeSubject, runs: readonly ProbeRun[], signal?: AbortSignal): Promise<{ status: "admitted" | "no_entry"; reason?: string }> {
  const rows = classifyRows(runs)
  if (!rows.some(row => row.verdict === "helped" || row.verdict === "hurt")) return { status: "no_entry", reason: "no row is helped or hurt; no reflector turn spent" }
  const data = rows.map(row => `- ${row.label} [${row.component ?? "none"}] ${row.verdict}: ${row.reason}`).join("\n")
  const reply = await runProbeTurn(runtime, { sessionID: subject.sid, prompt: REFLECT_STAGE_PROMPT, text: `${REFLECT_STAGE_PROMPT.text}${data}\n`, title: "otter probe reflection", signal })
  const parsed = parseReflection(reply)
  if (parsed.kind === "no_entry") return { status: "no_entry", reason: "reflector declined" }
  if (parsed.kind === "invalid") return { status: "no_entry", reason: parsed.reason }
  const admission = admitLesson(rows, parsed.candidate)
  if (!admission.ok) return { status: "no_entry", reason: admission.reason }
  appendLesson(runtime.worktree, { probeWid: subject.wid, subjectSha: subject.sha, admission })
  return { status: "admitted" }
}
