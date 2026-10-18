// Interactive host for the Otter-owned planning workflows (P6a S4): `/skill:deep-interview` and `/skill:ralplan`.
//
// The kind comes ONLY from the matched builtin PROTECTED_WORKFLOWS entry: user text, project files and model output never
// decide it, and invoking a name is not consent to anything (these kinds are read-only planning; nothing here can approve,
// execute or reach the ledger). Model calls, receipts and commits live in the engines; this module is presentation: inline
// choosers, the answer composer, the status segment, the DI -> ralplan preset and the stop/resume plumbing.
import { resumePaused } from "../flow/resume.ts"
import { observeStopSettlement, requestStop } from "../flow/runtime.ts"
import { activeAnyWorkflow, readAnyWorkflowChecked } from "../flow/state.ts"
import { STOP_LABEL } from "../flow/status.ts"
import { admissionFence, effectiveHold } from "../sessions/admission.ts"
import type { TranscriptKind } from "../sessions/store.ts"
import type { ProtectedWorkflowDescriptor } from "../skills/types.ts"
import { DI_MAX_ANSWER_CHARS } from "../workflows/deep-interview.ts"
import { dataOf as diDataOf } from "../workflows/deep-interview-data.ts"
import {
  deepInterviewView, retryDeepInterview, runDeepInterview, startDeepInterview, verifiedSpec, type DiAnswer, type DiIo,
} from "../workflows/deep-interview-driver.ts"
import { PLANNING_COMPLETE_TEXT, PLANNING_STUCK_MARKER, RALPLAN_MAX_OPENERS, ralplanDataOf, type RalplanWorkflow } from "../workflows/ralplan.ts"
import {
  confirmExecute, executeConfirmation, handoffToRalplan, retryRalplan, runRalplan, startRalplan, stopHere,
} from "../workflows/ralplan-driver.ts"
import { consensusLine } from "../workflows/ralplan-evidence.ts"
import { approveExperiment, autoresearchView, finishAutoresearch, productifyAutoresearch, retryAutoresearch, runAutoresearch, startAutoresearch } from "../workflows/autoresearch-driver.ts"
import { autoresearchDataOf, runConfirmation } from "../workflows/autoresearch.ts"
import { approveUnit, retryUltragoal, runUltragoal, startUltragoal, ultragoalView, type UnitController } from "../workflows/ultragoal-driver.ts"
import { approveUnitConfirmation, openGoals, ultragoalDataOf } from "../workflows/ultragoal.ts"
import type { WorkflowProgress } from "../tui/progress.ts"
import { startRefusal } from "../workflows/registry.ts"
import { stopDisplay, TERMINAL, type DeepInterviewWorkflow, type StopKind, type WorkflowEnvelope } from "../workflows/types.ts"
import type { Terminal } from "./interactive-session.ts"
import { AdmissionRefusal } from "./required-controls.ts"
import { boundedTerminalDiagnostic, terminalSafeText } from "./terminal-text.ts"
import { LinuxAdmissionRefused, type ExecutionRuntime } from "./types.ts"

export type WorkflowHostContext = {
  worktree: string
  terminal: Terminal
  runtime(): ExecutionRuntime
  sessionID(): string
  /** Aborts when the whole process is shutting down. */
  processSignal: AbortSignal
  persist(kind: TranscriptKind, data: Record<string, unknown>): void
  /** Read one submitted line (chat prompt "You> ") or a selection line, with progress output suspended. */
  readInput(input: { title: string; hint: string; prompt: string }, signal: AbortSignal): Promise<string | undefined>
  /** Explicit Resume preflight (runtime admission), as for plan Resume. */
  admit(): Promise<void>
  /** Run the approved implementation unit through the foreground controller. */
  runApprovedUnit(sessionID: string, signal?: AbortSignal, resumed?: boolean): Promise<unknown>
  /** Final-review hook for an isolated workflow: show its change and offer Apply / Keep / Discard. */
  finishIsolation?(workflowID: string): Promise<void>
  /** Clear the session hold for the held workflow at this revision (explicit Resume), as for plan Resume. */
  resumeHeld(revision: number): Promise<void>
  /** The running operation: Escape aborts it through the session's cancel handler. */
  setOperation(controller: AbortController | undefined): void
  /** The session's controller status text for `/status`. */
  statusText(): string
}


export type WorkflowOutcome = { quit: boolean }

const ANSWER_HINT = "Answer · /finish ends early · /pause · /cancel · /status · /quit"
const COMMANDS_BLOCKED_WHILE_ANSWERING = /^\/(help|skills|continue|model|new|resume|sessions|plan|skill:[a-z0-9_-]*)(\s|$)/u

/** `kind · stage · phase|stop label` of the committed workflow, plus the facts a reader needs; recomputed from committed state. */
/** Structured stage facts for the input-box progress bar; goal counts only where the state records them. */
export function workflowProgress(wf: WorkflowEnvelope): WorkflowProgress {
  let goals: WorkflowProgress["goals"]
  if (wf.kind === "ultragoal") {
    try {
      const data = ultragoalDataOf(wf as Extract<WorkflowEnvelope, { kind: "ultragoal" }>)
      const total = data.goals?.ids.length ?? 0
      if (total > 0) goals = { complete: total - openGoals(data).length, total }
    } catch { /* unreadable state: stage-only progress */ }
  }
  return { kind: wf.kind, stage: wf.stage, phase: wf.phase, ...(goals ? { goals } : {}) }
}

export function workflowStatusLine(worktree: string, wf: WorkflowEnvelope): string {
  const stop = stopDisplay(wf)
  const parts: string[] = [wf.kind, wf.stage, stop !== "none" ? STOP_LABEL[stop] : wf.phase]
  try {
    if (wf.kind === "deep-interview") {
      const view = deepInterviewView(wf as DeepInterviewWorkflow, worktree)
      if (view.round > 0) parts.push(`round ${view.round}`)
      if (view.ambiguity !== undefined) parts.push(`ambiguity ${Number(view.ambiguity.toFixed(3))} ${view.band}`)
      const stale = view.panel.filter(item => item.state === "incomplete").map(item => item.persona)
      if (stale.length) parts.push(`incomplete panel records: ${stale.join(", ")}`)
      if (!view.evidenceOk) parts.push("incomplete records")
    } else if (wf.kind === "ralplan") {
      const data = ralplanDataOf(wf as RalplanWorkflow)
      if (data.openers > 0) parts.push(`opener ${data.openers}/${RALPLAN_MAX_OPENERS}`)
      if (wf.stage === "pending_execution") parts.push("execution pending")
    } else if (wf.kind === "ultragoal") {
      parts.push(ultragoalView(wf as Extract<WorkflowEnvelope, { kind: "ultragoal" }>))
    } else if (wf.kind === "autoresearch") {
      parts.push(autoresearchView(wf as Extract<WorkflowEnvelope, { kind: "autoresearch" }>))
    }
  } catch { /* display only: a malformed record still shows kind and stage */ }
  return parts.join(" · ")
}

/**
 * Kind-generic pause/cancel request for the workflow this session owns. Terminal state is committed only by the owner's
 * settlement (observeStopSettlement), never by this call; the returned label says what is proven.
 */
export function requestWorkflowStop(runtime: ExecutionRuntime, worktree: string, sessionID: string, kind: StopKind): { ok: boolean; text: string } {
  const noun = kind === "pause" ? "Pause" : "Cancellation"
  const wf = activeAnyWorkflow(worktree)
  if (!wf || wf.sessionID !== sessionID) return { ok: false, text: `${noun} refused: no live workflow in this session.` }
  const requested = requestStop(runtime, sessionID, kind, `${kind} requested`, { workflowID: wf.id })
  if (!requested.result.ok) return { ok: false, text: `${noun} refused: ${boundedTerminalDiagnostic(requested.result.text)}` }
  const settle = () => {
    try { observeStopSettlement(runtime, sessionID, wf.owner.instance, "workflow-host") }
    catch (error) { runtime.log("workflow stop settlement failed", { sessionID, error: String(error) }) }
  }
  settle()
  void requested.quiesce.then(settle)
  const latest = readAnyWorkflowChecked(worktree).wf
  if (latest && latest.id === wf.id && TERMINAL.has(latest.phase)) return { ok: true, text: latest.phase === "cancelled" ? "cancelled" : latest.phase }
  const display = latest ? stopDisplay(latest) : "none"
  return { ok: true, text: display === "paused" ? "paused" : kind === "pause" ? STOP_LABEL.pausing : STOP_LABEL.cancelling }
}

export type WorkflowHost = {
  /** `/skill:<protected>`: the kind is the matched descriptor's, never the text's. */
  start(descriptor: ProtectedWorkflowDescriptor, request: string): Promise<WorkflowOutcome>
  /** `/finish` at the idle prompt while a deep interview awaits its answer. */
  finish(): Promise<WorkflowOutcome>
  /** A plain chat line while a deep interview awaits an answer is that answer. Returns undefined when no interview awaits one. */
  answer(text: string): Promise<WorkflowOutcome | undefined>
  /** `/continue` for a non-plan workflow: Keep/Resume for a pause or hold, otherwise re-drive from the committed stage. */
  continueActive(wf: WorkflowEnvelope): Promise<WorkflowOutcome>
  /** Refresh the status segment from committed state (clears it when no planning workflow is live). */
  syncStatus(): void
}

type DriveResult = WorkflowOutcome

const clip = (text: string, limit = 1_800): string => (text.length > limit ? `${text.slice(0, limit - 3)}...` : text)

export function createWorkflowHost(ctx: WorkflowHostContext): WorkflowHost {
  const { terminal, worktree } = ctx
  let lastStatus: string | undefined
  let quit = false

  const write = (text: string) => terminal.write(terminalSafeText(text.endsWith("\n") ? text : `${text}\n`))

  function show(wf: WorkflowEnvelope | null): void {
    const owned = wf && wf.kind !== "plan" && wf.sessionID === ctx.sessionID() ? wf : undefined
    const line = owned ? workflowStatusLine(worktree, owned) : undefined
    terminal.workflowStatus?.(line, owned ? workflowProgress(owned) : undefined)
    if (line === lastStatus) return
    lastStatus = line
    if (line === undefined || !wf) return
    ctx.persist("workflow-stage", { workflowID: wf.id, phase: wf.phase, text: `Workflow: ${line}` })
    if (!terminal.workflowStatus) write(`Workflow: ${line}`)
  }

  function syncStatus(): void {
    let wf: WorkflowEnvelope | null = null
    try { wf = activeAnyWorkflow(worktree) } catch { wf = null }
    show(wf)
  }

  /** Inline chooser list; without a chooser a numbered prompt. Dismissal is `undefined`. */
  async function choose(title: string, choices: readonly string[], signal: AbortSignal | undefined, workflowID: string): Promise<number | undefined> {
    const safeTitle = terminalSafeText(title)
    const safeChoices = choices.map(terminalSafeText)
    const active = signal ?? ctx.processSignal
    let index: number | undefined
    if (terminal.choose) index = await terminal.choose(safeTitle, safeChoices, active)
    else {
      write(`${safeTitle}\n${safeChoices.map((choice, i) => `  ${i + 1}) ${choice}`).join("\n")}`)
      for (;;) {
        const line = await ctx.readInput({ title: "Choice", hint: "Enter a number; empty dismisses", prompt: `Choice [1-${choices.length}]: ` }, active)
        if (line === undefined || line.trim() === "") break
        const picked = Number(line.trim())
        if (Number.isSafeInteger(picked) && picked >= 1 && picked <= choices.length) { index = picked - 1; break }
        write("Choose a listed number or press Enter to dismiss.")
      }
    }
    if (index !== undefined && !active.aborted) ctx.persist("workflow-choice", { workflowID, text: clip(`${title.split("\n")[0]}: ${choices[index]}`, 400) })
    return index
  }

  // ---------------------------------------------------------------------------------------- deep-interview
  function diIo(workflowID: string, first: DiAnswer | undefined): DiIo {
    let pending = first
    let shown = -1
    return {
      choose: (title, choices, signal) => choose(title, choices, signal, workflowID),
      async readNote(title, signal) {
        const line = await ctx.readInput({ title, hint: "Enter sends the note; empty cancels", prompt: "Note> " }, signal ?? ctx.processSignal)
        return line === undefined || line.trim() === "" ? undefined : line
      },
      notice: text => write(text),
      async readAnswer(open, signal) {
        if (pending) { const answer = pending; pending = undefined; return answer }
        const active = signal ?? ctx.processSignal
        const options = open.options
        const fresh = shown !== open.round
        if (fresh) {
          shown = open.round
          const ask = terminal.ask
          if (options && options.length > 0 && ask) {
            const picked = await ask.call(terminal, {
              question: terminalSafeText(`Question ${open.round}: ${open.question}`),
              options: options.map(label => ({ label: terminalSafeText(label) })),
              ...(open.recommended === undefined ? {} : { recommended: open.recommended }),
              allowCustom: true,
            }, active)
            if (active.aborted) return undefined
            let text: string | undefined
            if (picked?.kind === "option") text = options[picked.index]
            else if (picked?.kind === "custom") text = picked.text.trim().slice(0, DI_MAX_ANSWER_CHARS)
            if (text) {
              ctx.persist("user", { text })
              return { kind: "answer", text }
            }
            write(`Question ${open.round}:\n${open.question}`)
          } else {
            write(`Question ${open.round}:\n${open.question}`)
          }
          if (options && options.length > 0) {
            write(`${options.map((label, i) => `  ${i + 1}) ${label}${open.recommended === i ? " (Recommended)" : ""}`).join("\n")}\nType a number or your own answer; /finish ends early.`)
          }
        }
        for (;;) {
          const line = await ctx.readInput({ title: `deep-interview · round ${open.round}`, hint: ANSWER_HINT, prompt: "You> " }, active)
          if (line === undefined || active.aborted) return undefined
          const text = line.trim()
          if (!text) continue
          if (text === "/finish") return { kind: "finish" }
          if (text === "/status") { write(ctx.statusText()); continue }
          if (text === "/pause" || text === "/cancel") {
            const stop = requestWorkflowStop(ctx.runtime(), worktree, ctx.sessionID(), text === "/pause" ? "pause" : "cancel")
            write(stop.text)
            return undefined
          }
          if (text === "/quit" || text === "/exit") { quit = true; return undefined }
          if (COMMANDS_BLOCKED_WHILE_ANSWERING.test(text)) {
            write("That command is unavailable while an interview awaits an answer: answer, /finish, /pause, /cancel, /status or /quit.")
            continue
          }
          if (options && /^[0-9]+$/u.test(text)) {
            const picked = Number(text)
            if (picked >= 1 && picked <= options.length) {
              ctx.persist("user", { text: options[picked - 1]! })
              return { kind: "answer", text: options[picked - 1]! }
            }
          }
          ctx.persist("user", { text: line })
          return { kind: "answer", text: line }
        }
      },
    }
  }

  function committedKind<K extends WorkflowEnvelope["kind"]>(id: string, kind: K): Extract<WorkflowEnvelope, { kind: K }> | undefined {
    let read: ReturnType<typeof readAnyWorkflowChecked>
    try { read = readAnyWorkflowChecked(worktree) } catch { return undefined }
    return read.wf && read.wf.id === id && read.wf.kind === kind ? read.wf as Extract<WorkflowEnvelope, { kind: K }> : undefined
  }

  /** Run the operation under an abortable controller that the session's Escape / cancel handler aborts. */
  async function operate<T>(body: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const controller = new AbortController()
    const signal = AbortSignal.any([ctx.processSignal, controller.signal])
    ctx.setOperation(controller)
    ctx.terminal.queueAdmission?.(false)
    try { return { ok: true, value: await body(signal) } }
    catch (error) {
      if (signal.aborted) return { ok: false }
      if (error instanceof AdmissionRefusal || error instanceof LinuxAdmissionRefused) throw error
      throw error
    } finally { ctx.setOperation(undefined) }
  }

  async function driveInterview(workflowID: string, first?: DiAnswer): Promise<DriveResult> {
    let answer = first
    for (;;) {
      const start = committedKind(workflowID, "deep-interview")
      if (!start) { write("The interview is no longer the committed workflow; check /status."); return { quit } }
      const io = diIo(workflowID, answer)
      answer = undefined
      const request = diDataOf(start).request
      const ran = await operate(signal => runDeepInterview(ctx.runtime(), ctx.sessionID(), workflowID, io, {
        signal,
        onStep: wf => show(wf),
        handoff: (done, events) => {
          const handed = handoffToRalplan(ctx.runtime(), ctx.sessionID(), done, request, events)
          return handed.ok ? { ok: true, successor: handed.wf } : { ok: false, text: handed.text }
        },
      }))
      if (!ran.ok) { syncStatus(); write("Interview interrupted; the committed state is unchanged. /status shows it, /continue resumes, /cancel stops."); return { quit } }
      const result = ran.value
      if (quit) return { quit }
      switch (result.status) {
        case "handed_off": {
          show(result.successor ?? null)
          const spec = result.wf ? verifiedSpec(worktree, result.wf) : undefined
          write(`Specification verified${spec?.ok ? ` (${spec.path}, sha256 ${spec.sha256})` : ""}. Connected to ralplan as ${result.successor!.id}: planning only, nothing is executed.`)
          return driveRalplan(result.successor!.id)
        }
        case "done": {
          const spec = result.wf ? verifiedSpec(worktree, result.wf) : undefined
          write(spec?.ok ? `Interview complete. Verified specification: ${spec.path} (sha256 ${spec.sha256}). Nothing was executed.` : "Interview complete.")
          syncStatus()
          return { quit }
        }
        case "stuck": {
          const wf = committedKind(workflowID, "deep-interview")
          if (!wf) return { quit }
          const d = diDataOf(wf)
          const evidence = (d.stuck?.evidence ?? []).slice(-3).map(item => `- ${clip(item, 300)}`).join("\n")
          const index = await choose(`The interview is stuck at ${d.stuck?.item ?? wf.stage}: ${clip(d.stuck?.reason ?? "unknown", 400)}${evidence ? `\nEvidence:\n${evidence}` : ""}`, ["Retry the step", "Keep stuck (inspect with /status, stop with /cancel)"], undefined, workflowID)
          if (index === 0) {
            const retried = retryDeepInterview(ctx.runtime(), ctx.sessionID(), workflowID, wf.lastSeq)
            if (retried.ok) continue
            write(`Retry refused: ${retried.text}`)
          }
          syncStatus()
          return { quit }
        }
        case "exited": write("Interview cancelled; rounds and receipts are retained, nothing was executed."); syncStatus(); return { quit }
        case "blocked": write(`Interview is not running: ${result.reason ?? "blocked"}.`); syncStatus(); return { quit }
        case "stale": write(`Interview stopped: ${result.reason ?? "workflow changed"}.`); syncStatus(); return { quit }
        case "awaiting": syncStatus(); return { quit }
      }
    }
  }

  // ---------------------------------------------------------------------------------------- ralplan
  async function offerExecution(wf: RalplanWorkflow): Promise<void> {
    const data = ralplanDataOf(wf)
    const line = consensusLine(worktree, wf) ?? "consensus unverified"
    const pending = wf.artifacts.find(ref => ref.key === "pending-approval.md")?.path
    write(`Consensus: ${line}${pending ? `\nPlan: ${pending}` : ""}`)
    const index = await choose(
      `Consensus reached: ${line}\nPlanning is complete; nothing has been executed and invoking a workflow is not consent to execute.`,
      ["Stop here (planning complete; not executed)", "Execute via ultragoal (needs a typed confirmation)", "Decide later"], undefined, wf.id)
    if (index === 0) {
      const stopped = stopHere(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq)
      write(stopped.ok ? PLANNING_COMPLETE_TEXT : `Stop refused: ${stopped.text}`)
    } else if (index === 1) {
      const planSha = data.consensus?.planSha
      if (!planSha) { write("Execution refused: no verified consensus."); return }
      const typed = await ctx.readInput({ title: `Confirm execution: type exactly ${executeConfirmation(wf.id, planSha)}`, hint: "Exact text; empty cancels", prompt: "Confirm> " }, ctx.processSignal)
      if (typed === undefined || typed.trim() === "") { write("Execution not confirmed; the plan stays pending."); return }
      const confirmed = confirmExecute(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq, typed)
      write(confirmed.ok ? "Connected to ultragoal: nothing runs until each unit is reviewed and you approve it with its own typed receipt." : `Execution not started: ${confirmed.text}`)
    } else {
      write("The plan stays pending; /continue offers the choice again.")
    }
  }

  async function driveRalplan(workflowID: string): Promise<DriveResult> {
    for (;;) {
      const ran = await operate(signal => runRalplan(ctx.runtime(), ctx.sessionID(), workflowID, { signal, onStep: wf => show(wf) }))
      if (!ran.ok) { syncStatus(); write("Planning interrupted; the committed state is unchanged. /status shows it, /continue resumes, /cancel stops."); return { quit } }
      const result = ran.value
      const wf = committedKind(workflowID, "ralplan")
      switch (result.status) {
        case "pending_execution":
          if (wf) { show(wf); await offerExecution(wf) }
          syncStatus()
          return { quit }
        case "done": write(PLANNING_COMPLETE_TEXT); syncStatus(); return { quit }
        case "stuck": {
          const data = wf ? ralplanDataOf(wf) : undefined
          if (wf && data?.stuck?.kind === "attempts") {
            const index = await choose(`Planning is stuck at ${wf.stage}: ${clip(data.stuck.reason, 600)}`, ["Retry the step", "Keep stuck (inspect with /status, stop with /cancel)"], undefined, workflowID)
            if (index === 0) {
              const retried = retryRalplan(ctx.runtime(), ctx.sessionID(), workflowID, wf.lastSeq)
              if (retried.ok) continue
              write(`Retry refused: ${retried.text}`)
            }
          } else write(`${PLANNING_STUCK_MARKER}: ${clip(data?.stuck?.reason ?? result.reason ?? "no consensus", 600)}. The best plan is kept (see /status); nothing was executed. /cancel clears this workflow.`)
          syncStatus()
          return { quit }
        }
        case "blocked": write(`Planning is not running: ${result.reason ?? "blocked"}.`); syncStatus(); return { quit }
        case "stale": write(`Planning stopped: ${result.reason ?? "workflow changed"}.`); syncStatus(); return { quit }
      }
    }
  }

  // ---------------------------------------------------------------------------------------- ultragoal
  const unitController: UnitController = {
    runApprovedUnit: (sessionID, signal, resumed) => ctx.runApprovedUnit(sessionID, signal, resumed),
  }

  async function driveUltragoal(workflowID: string): Promise<DriveResult> {
    for (;;) {
      const ran = await operate(signal => runUltragoal(ctx.runtime(), unitController, ctx.sessionID(), workflowID, { signal, onStep: wf => show(wf) }))
      if (!ran.ok) { syncStatus(); write("Ultragoal interrupted; the committed state is unchanged. /status shows it, /continue resumes, /cancel stops."); return { quit } }
      const result = ran.value
      const wf = committedKind(workflowID, "ultragoal")
      switch (result.status) {
        case "approval": {
          if (!wf) { syncStatus(); return { quit } }
          show(wf)
          const pending = ultragoalDataOf(wf).pending
          if (!pending) { write("Unit approval is unavailable: no pending unit."); syncStatus(); return { quit } }
          const exact = approveUnitConfirmation(wf.id, pending.subject.sha256)
          write(`Unit ${pending.goalId} attempt ${pending.attempt} is reviewed. Nothing runs unless you type the exact approval.\nType exactly: ${exact}`)
          const typed = await ctx.readInput({ title: "Approve unit", hint: "Exact APPROVE-UNIT text; empty keeps pending", prompt: "Confirm> " }, ctx.processSignal)
          if (typed === undefined || typed.trim() === "") { write("Unit not approved; the workflow stays pending."); syncStatus(); return { quit } }
          const approved = approveUnit(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq, typed)
          if (!approved.ok) { write(`Unit approval refused: ${approved.text}`); syncStatus(); return { quit } }
          write("Unit approved; executing through the owned queue and verifier.")
          show(approved.wf)
          continue
        }
        case "done":
          write("Ultragoal complete. All goals have current verified checkpoints and completion proof.")
          await ctx.finishIsolation?.(workflowID)
          syncStatus()
          return { quit }
        case "stuck": {
          if (!wf) { syncStatus(); return { quit } }
          const index = await choose(`Ultragoal is stuck: ${clip(result.reason ?? ultragoalView(wf), 600)}`, ["Retry the step", "Keep stuck (inspect with /status, stop with /cancel)"], undefined, wf.id)
          if (index === 0) {
            const retried = retryUltragoal(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq)
            if (retried.ok) continue
            write(`Retry refused: ${retried.text}`)
          }
          syncStatus()
          return { quit }
        }
        case "blocked": write(`Ultragoal is not running: ${result.reason ?? "blocked"}.`); syncStatus(); return { quit }
        case "stale": write(`Ultragoal stopped: ${result.reason ?? "workflow changed"}.`); syncStatus(); return { quit }
      }
    }
  }

  // ---------------------------------------------------------------------------------------- autoresearch
  async function offerAutoresearchChoice(wf: Extract<WorkflowEnvelope, { kind: "autoresearch" }>): Promise<WorkflowOutcome> {
    const data = autoresearchDataOf(wf)
    const verdict = data.verdict
    const choice = await choose(
      `Autoresearch verdict ${verdict?.status ?? "unverified"} is available. Productification starts a NEW deep-interview seeded with the verdict; it grants no execution consent.`,
      ["Finish research", "Productify into deep-interview", "Decide later"], undefined, wf.id)
    if (choice === 0) {
      const done = finishAutoresearch(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq)
      write(done.ok ? `Autoresearch finished (${done.wf.phase}).` : `Finish refused: ${done.text}`)
      syncStatus()
      return { quit }
    }
    if (choice === 1) {
      const seeded = productifyAutoresearch(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq)
      if (!seeded.ok) { write(`Productify refused: ${seeded.text}`); syncStatus(); return { quit } }
      write(`Productified autoresearch into deep-interview ${seeded.successor.id}; clarification only, no execution consent was inherited.`)
      show(seeded.successor)
      return driveInterview(seeded.successor.id)
    }
    write("The research verdict stays pending; /continue offers the choice again.")
    syncStatus()
    return { quit }
  }

  async function driveAutoresearch(workflowID: string): Promise<DriveResult> {
    for (;;) {
      const ran = await operate(signal => runAutoresearch(ctx.runtime(), ctx.sessionID(), workflowID, { signal, onStep: wf => show(wf) }))
      if (!ran.ok) { syncStatus(); write("Autoresearch interrupted; the committed state is unchanged. /status shows it, /continue resumes, /cancel stops."); return { quit } }
      const result = ran.value
      const wf = committedKind(workflowID, "autoresearch")
      switch (result.status) {
        case "approval": {
          if (!wf) { syncStatus(); return { quit } }
          show(wf)
          const pending = autoresearchDataOf(wf).pending
          if (!pending) { write("Experiment approval is unavailable: no pending experiment."); syncStatus(); return { quit } }
          const exact = runConfirmation(wf.id, pending.subject.sha256)
          write(`Experiment iteration ${pending.iteration} is prepared. No command runs unless you type the exact approval.\nType exactly: ${exact}`)
          const typed = await ctx.readInput({ title: "Approve experiment", hint: "Exact RUN text; empty keeps pending", prompt: "Confirm> " }, ctx.processSignal)
          if (typed === undefined || typed.trim() === "") { write("Experiment not approved; the workflow stays pending."); syncStatus(); return { quit } }
          const approved = approveExperiment(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq, typed)
          if (!approved.ok) { write(`Experiment approval refused: ${approved.text}`); syncStatus(); return { quit } }
          write("Experiment approved; running through the verifier.")
          show(approved.wf)
          continue
        }
        case "choice":
          if (wf) return offerAutoresearchChoice(wf)
          syncStatus()
          return { quit }
        case "done": write("Autoresearch complete. Verdict and run evidence verified."); syncStatus(); return { quit }
        case "stuck": {
          if (!wf) { syncStatus(); return { quit } }
          if (wf.stage === "terminal") return offerAutoresearchChoice(wf)
          const index = await choose(`Autoresearch is stuck: ${clip(result.reason ?? autoresearchView(wf), 600)}`, ["Retry the step", "Keep stuck (inspect with /status, stop with /cancel)"], undefined, wf.id)
          if (index === 0) {
            const retried = retryAutoresearch(ctx.runtime(), ctx.sessionID(), wf.id, wf.lastSeq)
            if (retried.ok) continue
            write(`Retry refused: ${retried.text}`)
          }
          syncStatus()
          return { quit }
        }
        case "blocked": write(`Autoresearch is not running: ${result.reason ?? "blocked"}.`); syncStatus(); return { quit }
        case "stale": write(`Autoresearch stopped: ${result.reason ?? "workflow changed"}.`); syncStatus(); return { quit }
      }
    }
  }

  async function drive(wf: WorkflowEnvelope, first?: DiAnswer): Promise<DriveResult> {
    if (wf.kind === "deep-interview") return driveInterview(wf.id, first)
    if (wf.kind === "ralplan") return driveRalplan(wf.id)
    if (wf.kind === "ultragoal") return driveUltragoal(wf.id)
    if (wf.kind === "autoresearch") return driveAutoresearch(wf.id)
    write(`${wf.kind} workflows are not available here.`)
    return { quit }
  }

  // ---------------------------------------------------------------------------------------- entry points
  async function start(descriptor: ProtectedWorkflowDescriptor, request: string): Promise<WorkflowOutcome> {
    const kind = descriptor.workflow
    const refusal = startRefusal(kind)
    if (refusal) { write(`Protected workflow ${descriptor.name} is not available: ${refusal}.`); return { quit } }
    ctx.persist("user", { text: `/skill:${descriptor.name}${request ? ` ${request}` : ""}` })
    const runtime = ctx.runtime()
    const started = kind === "deep-interview"
      ? startDeepInterview(runtime, ctx.sessionID(), request)
      : kind === "ralplan" ? startRalplan(runtime, ctx.sessionID(), request)
        : kind === "ultragoal" ? startUltragoal(runtime, ctx.sessionID(), request)
          : kind === "autoresearch" ? startAutoresearch(runtime, ctx.sessionID(), request)
            : { ok: false as const, text: `${kind} workflows are not available here` }
    if (!started.ok) { write(`${descriptor.name} was not started: ${started.text}`); syncStatus(); return { quit } }
    write(`Started ${kind} ${started.wf.id}: invoking a name is not execution consent; typed approvals are still required.`)
    show(started.wf)
    return drive(started.wf)
  }

  async function finish(): Promise<WorkflowOutcome> {
    const wf = activeAnyWorkflow(worktree)
    if (!wf || wf.kind !== "deep-interview" || wf.sessionID !== ctx.sessionID() || wf.stage !== "answer" || wf.phase !== "planning" || wf.stopIntent || effectiveHold(worktree, ctx.sessionID())) {
      write("/finish applies only while an interview awaits an answer.")
      return { quit }
    }
    return drive(wf, { kind: "finish" })
  }

  async function answer(text: string): Promise<WorkflowOutcome | undefined> {
    const wf = activeAnyWorkflow(worktree)
    if (!wf || wf.kind !== "deep-interview" || wf.sessionID !== ctx.sessionID() || wf.stage !== "answer" || wf.phase !== "planning" || wf.stopIntent || effectiveHold(worktree, ctx.sessionID())) return undefined
    ctx.persist("user", { text })
    return drive(wf, { kind: "answer", text })
  }

  async function continueActive(wf: WorkflowEnvelope): Promise<WorkflowOutcome> {
    const sid = ctx.sessionID()
    if (wf.sessionID !== sid) { write(`Resume refused: workflow belongs to ${wf.sessionID}; use /resume ${wf.sessionID}.`); return { quit } }
    if (wf.stopIntent?.kind === "cancel") { write("Resume refused: workflow cancellation is pending; termination is unconfirmed."); return { quit } }
    const keepOrResume = async (title: string) => (await choose(title, ["Keep held", "Resume"], undefined, wf.id)) === 1
    if (wf.phase === "paused" || wf.stopIntent?.kind === "pause") {
      write(ctx.statusText())
      try {
        const outcome = await resumePaused(ctx.runtime(), sid, wf.lastSeq, {
          preflight: () => ctx.admit(), fence: () => admissionFence(worktree, sid),
          choose: () => keepOrResume("Resume the paused planning workflow? It continues at its stage; nothing is executed."),
        })
        if (outcome.kind === "refused") { write(`Resume refused (${outcome.precondition}): ${outcome.reason}`); return { quit } }
        if (outcome.kind === "kept") { write("Kept held; no work was started."); return { quit } }
        const resumed = activeAnyWorkflow(worktree)
        write(`Resumed ${outcome.wf.kind} ${outcome.wf.id}: ${outcome.wf.phase}.`)
        return resumed ? drive(resumed) : { quit }
      } catch (error) { write(`Resume refused or incomplete: ${boundedTerminalDiagnostic(String(error))}`); return { quit } }
    }
    if (effectiveHold(worktree, sid)) {
      write(ctx.statusText())
      if (!await keepOrResume("Resume this held planning workflow after recovery checks?")) return { quit }
      try { await ctx.resumeHeld(wf.lastSeq) }
      catch (error) { write(`Resume refused or incomplete: ${boundedTerminalDiagnostic(String(error))}`); return { quit } }
      const fresh = activeAnyWorkflow(worktree)
      return fresh ? drive(fresh) : { quit }
    }
    return drive(wf)
  }

  return { start, finish, answer, continueActive, syncStatus }
}
