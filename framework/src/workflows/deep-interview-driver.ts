// Deep-interview driver (P6a S2). Runs the engine step by step: every model call is a bound, read-only
// `runWorkflowTurn`; its text is parsed as typed stage events; this code writes artifacts and receipts and commits one
// transition per step with compare-and-swap on the committed revision. Human input (answers, inline choices, notes)
// arrives through `DiIo`; nothing here can start an implementation, approve a plan or reach the ledger. A diagnostic
// result (stale binding) applies nothing. The interactive dispatch that owns `DiIo` (the /skill: command, /finish
// routing, status line, the ralplan preset) is `hosts/workflow-session.ts`, which calls the API exported here.
import { resolve } from "node:path"
import { currentOwner } from "../flow/owner.ts"
import { assertFlowTxWorktree, newWorkflowId, readAnyWorkflowForWrite, rotate, withFlowTransaction, workflowReadError } from "../flow/state.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import { effectiveHold } from "../sessions/admission.ts"
import { sessionGuard } from "./session-guard.ts"
import { getOwnedSession, readSessionMetadata } from "../sessions/store.ts"
import { durableWriteBytes } from "../state/durable.ts"
import { readArtifactBytes, sha256 } from "./artifacts.ts"
import { commitRevision, readCommitted, type CommitEvent } from "./commit.ts"
import {
  choiceInputSha, closureInputSha, dataOf, DI_MAX_ANSWER_CHARS, DI_REQUEST_MAX, earlyExitRefusal, finalAmbiguity, newData, nextStep, reduce, renderSpec,
  restatementInputSha, roundFileRelative, sha256Text, specRelative, topologyInputSha,
  agendaProgress, nextAgenda, questionLimit, bandOf,
  type Component, type DeepInterviewData, type DiEvent, type DiStep, type Persona, type ProjectType, type ReduceResult,
} from "./deep-interview.ts"
import { DI_CLOSURE_PROMPT, DI_CRYSTALLIZE_PROMPT, DI_PANEL_PROMPTS, DI_QUESTION_PROMPT, DI_RESTATEMENT_PROMPT, DI_SCORER_PROMPT, DI_TOPOLOGY_PROMPT, type StagePrompt } from "./prompts/index.ts"
import { verifyReceiptRef, writeReceipt } from "./receipts.ts"
import { deepInterviewEvidence, evidenceSummary } from "./deep-interview-evidence.ts"
import { parseStageEventsFor, runWorkflowTurn, type StageEvent, type TurnBinding } from "./turn.ts"
import { TERMINAL, type DeepInterviewWorkflow, type WorkflowEnvelope } from "./types.ts"

/** Same bounded conversation budget as the plan conversation: 24k chars of request, 8k reserved for the reply. */
export const DI_TURN_BUDGET = Object.freeze({ maxChars: 24_000, reserveChars: 8_000 })
const OLD_ROUND_CHARS = 1_500

export const isDeepInterview = (wf: WorkflowEnvelope | null | undefined): wf is DeepInterviewWorkflow => wf?.kind === "deep-interview"

// ---------------------------------------------------------------------------------------------- start
export type StartResult = { ok: true; wf: DeepInterviewWorkflow } | { ok: false; text: string }

function admission(runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string): { epoch: string } | string {
  let store: ReturnType<typeof getOwnedSession>
  try { store = getOwnedSession(runtime.worktree, sessionID) }
  catch (error) { return `session attachment is unavailable: ${(error as Error)?.message ?? String(error)}` }
  if (!store || effectiveHold(runtime.worktree, sessionID)) return `session ${sessionID} has no live admission; use /resume ${sessionID} before starting a workflow`
  let metadata: ReturnType<typeof readSessionMetadata>
  try { metadata = readSessionMetadata(runtime.worktree, sessionID) }
  catch (error) { return `session attachment state is unavailable: ${(error as Error)?.message ?? String(error)}` }
  if (store.metadata.held || !metadata || metadata.held || metadata.engine !== runtime.host.identity.engine) {
    return "session attachment is held or its engine does not match; /resume is required before starting a workflow"
  }
  return { epoch: store.epoch }
}

export function newDeepInterview(
  sessionID: string,
  owner: { instance: string; pid: number },
  engine: string,
  request: string,
  now = Date.now(),
  seed?: DeepInterviewData["seed"],
): DeepInterviewWorkflow {
  return {
    version: 2, id: newWorkflowId(now), kind: "deep-interview", stage: "topology", engine, phase: "planning", sessionID,
    owner: { instance: owner.instance, pid: owner.pid }, stopIntent: null, artifacts: [],
    data: seed ? { ...newData(request), seed } : newData(request), lastSeq: 0, createdAt: now, updatedAt: now,
  } as DeepInterviewWorkflow
}

/** Start in the free (or terminal) slot. Refuses while any workflow is active or the session has no live unheld admission. */
export function startDeepInterview(runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string, request: string, options: { now?: number } = {}): StartResult {
  if (!request.trim()) return { ok: false, text: "a deep interview needs a request" }
  if (request.length > DI_REQUEST_MAX) return { ok: false, text: `the request exceeds ${DI_REQUEST_MAX} characters` }
  const now = options.now ?? Date.now()
  return withFlowTransaction(runtime.worktree, (tx): StartResult => {
    assertFlowTxWorktree(tx, runtime.worktree)
    const occupant = readAnyWorkflowForWrite(tx)
    if (occupant.corrupt) throw workflowReadError(occupant)
    if (occupant.wf && !TERMINAL.has(occupant.wf.phase)) {
      return { ok: false, text: `${occupant.wf.kind} workflow ${occupant.wf.id} is active${occupant.wf.sessionID === sessionID ? "; use /status or /cancel" : ` in session ${occupant.wf.sessionID}`}` }
    }
    const admitted = admission(runtime, sessionID)
    if (typeof admitted === "string") return { ok: false, text: admitted }
    const created = newDeepInterview(sessionID, currentOwner(now, admitted.epoch), String(runtime.host.identity.engine), request, now)
    rotate(tx)
    const wf = commitRevision(tx, created, [
      { wf: created.id, type: "created", actor: "code", data: { kind: "deep-interview", chars: request.length, threshold: created.data.threshold, thresholdSource: created.data.thresholdSource } },
      { wf: created.id, type: "transition", to: "planning", actor: "code", data: { event: "start" } },
    ], now)
    return { ok: true, wf: wf as DeepInterviewWorkflow }
  })
}

// ---------------------------------------------------------------------------------------------- commit
export type CommitOutcome = { ok: true; wf: DeepInterviewWorkflow } | { ok: false; text: string }
export type CommitBuild = (fresh: DeepInterviewWorkflow) => ReduceResult

/**
 * The committed workflow must still be exactly `expected` (same revision, stage, phase, no stop intent), otherwise nothing
 * is written. `build` runs against the fresh record inside the transaction, so receipt and artifact checks happen with
 * the publish; a refusal returns the reason and leaves the previous index authoritative.
 */
export function commitDeepInterview(worktree: string, expected: DeepInterviewWorkflow, build: CommitBuild, now = Date.now()): CommitOutcome {
  return withFlowTransaction(worktree, (tx): CommitOutcome => {
    const checked = readAnyWorkflowForWrite(tx)
    if (checked.corrupt) throw workflowReadError(checked)
    const fresh = checked.wf
    if (!fresh || !isDeepInterview(fresh) || fresh.id !== expected.id || fresh.lastSeq !== expected.lastSeq || fresh.stage !== expected.stage || fresh.phase !== expected.phase) {
      return { ok: false, text: "workflow changed meanwhile; stop and check /status" }
    }
    if (fresh.stopIntent) return { ok: false, text: `workflow ${fresh.stopIntent.kind} is pending` }
    const guard = sessionGuard(worktree, fresh)
    if (guard) return { ok: false, text: guard }
    try {
      const built = build(fresh)
      if (!built.ok) return { ok: false, text: built.text }
      const committed = commitRevision(tx, { ...built.wf, lastSeq: fresh.lastSeq } as WorkflowEnvelope, built.events, now, { receipts: built.receipts })
      return { ok: true, wf: committed as DeepInterviewWorkflow }
    } catch (error) {
      return { ok: false, text: (error as Error).message }
    }
  })
}

function committed(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string): DeepInterviewWorkflow | string {
  let read: ReturnType<typeof readCommitted>
  try { read = readCommitted(runtime.worktree) } catch { return "workflow state is unreadable" }
  if (read.state !== "ok") return "workflow state is unavailable"
  const { wf } = read
  if (wf.id !== workflowID || wf.sessionID !== sessionID) return "workflow identity changed"
  if (!isDeepInterview(wf)) return `workflow is a ${wf.kind} workflow`
  return wf
}

const apply = (wf: DeepInterviewWorkflow, event: DiEvent, worktree: string, now?: number) => (fresh: DeepInterviewWorkflow): ReduceResult => reduce(fresh, event, { worktree, now })

// ---------------------------------------------------------------------------------------------- io
export type DiAnswer = { kind: "answer"; text: string } | { kind: "finish" }

/** Everything the driver needs from a human. `undefined` means the surface went away; the run returns `awaiting`. */
export type DiIo = {
  /** Inline terminal chooser: the selected index. */
  choose(title: string, choices: readonly string[], signal?: AbortSignal): Promise<number | undefined>
  /** The next chat line is the answer to the open question; `/finish` is the early-exit request. */
  readAnswer(open: { round: number; question: string; options?: string[]; recommended?: number;
    agenda?: { id: string; description: string; index: number; total: number; question: number; limit: number } }, signal?: AbortSignal): Promise<DiAnswer | undefined>
  /** Free-text operator note for an Adjust choice. */
  readNote(title: string, signal?: AbortSignal): Promise<string | undefined>
  notice?(text: string): void
}

// ---------------------------------------------------------------------------------------------- files
function writeText(worktree: string, relative: string, text: string): string {
  const absolute = resolve(worktree, relative)
  durableWriteBytes(absolute, Buffer.from(text, "utf8"))
  return sha256(Buffer.from(text, "utf8"))
}

const QUESTION_OPTIONS_MAX_BYTES = 8 * 1024
const questionOptionsRelative = (sessionID: string, workflowID: string, n: number): string =>
  roundFileRelative(sessionID, workflowID, n, "question").replace(/\.md$/u, ".options.json")

/** Optional answer options stored beside the question. Absent, oversized or malformed means no options; never an error. */
function readQuestionOptions(worktree: string, wf: DeepInterviewWorkflow, n: number): { options?: string[]; recommended?: number } {
  try {
    const read = readArtifactBytes(resolve(worktree, questionOptionsRelative(wf.sessionID, wf.id, n)), QUESTION_OPTIONS_MAX_BYTES)
    if (!read.ok) return {}
    const parsed: unknown = JSON.parse(read.bytes.toString("utf8"))
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const { options, recommended } = parsed as { options?: unknown; recommended?: unknown }
    if (!Array.isArray(options) || options.length < 1 || options.length > 5) return {}
    if (!options.every(item => typeof item === "string" && item.length >= 1 && item.length <= 200)) return {}
    const valid = typeof recommended === "number" && Number.isInteger(recommended) && recommended >= 0 && recommended < options.length
    return { options: options as string[], ...(valid ? { recommended } : {}) }
  } catch { return {} }
}

function readRound(worktree: string, wf: DeepInterviewWorkflow, n: number, part: "question" | "answer", expected: string | undefined): string {
  const read = readArtifactBytes(resolve(worktree, roundFileRelative(wf.sessionID, wf.id, n, part)))
  if (!read.ok) throw new Error(`round ${n} ${part} is ${read.reason}`)
  if (expected === undefined || sha256(read.bytes) !== expected) throw new Error(`round ${n} ${part} does not match its recorded hash`)
  return read.bytes.toString("utf8")
}

function transcriptOf(worktree: string, wf: DeepInterviewWorkflow, d: DeepInterviewData): string {
  if (d.rounds.length === 0) return "(no rounds yet)"
  const clip = (text: string, latest: boolean) => (latest || text.length <= OLD_ROUND_CHARS ? text : `${text.slice(0, 1000)}\n[... middle omitted ...]\n${text.slice(-500)}`)
  return d.rounds.map((round, index) => {
    const latest = index === d.rounds.length - 1
    const q = readRound(worktree, wf, round.n, "question", round.questionSha)
    const a = round.answerSha === undefined ? "(not answered)" : readRound(worktree, wf, round.n, "answer", round.answerSha)
    const scored = round.ambiguity === undefined ? "" : ` [ambiguity ${round.ambiguity}, band ${round.band}]`
    return `Round ${round.n}${round.agendaID ? ` [agenda ${round.agendaID}]` : ""}${scored}\nQ: ${clip(q, latest)}\nA: ${clip(a, latest)}`
  }).join("\n\n")
}

const MARK = "=== "
const section = (label: string, text: string) => `${MARK}${label} ===\n${text.trim()}\n`

type Context = { text: string; source: string; rebuild(summary: string): string }
function compose(prompt: StagePrompt, sections: ReadonlyArray<readonly [string, string]>): Context {
  const source = sections.map(([label, text]) => section(label, text)).join("\n")
  const pinned = sections.filter(([label]) => ["ACTIVE AGENDA", "TASK AGENDAS", "QUESTION BUDGET"].includes(label)).map(([label, text]) => section(label, text)).join("\n")
  return { text: `${prompt.text}${source}`, source, rebuild: summary => `${prompt.text}${pinned}${section("SUMMARIZED CONTEXT", summary)}` }
}

function agendaContext(d: DeepInterviewData, activeID?: string): Array<readonly [string, string]> {
  if (!d.questionPolicy) return []
  const agendas = agendaProgress(d)
  const active = agendas.find(item => item.id === activeID)
  return [
    ["TASK AGENDAS", agendas.map(item => `- ${item.id}: ${item.description.slice(0, 160)}; ${item.status}; questions ${item.asked}/${d.questionPolicy!.maxPerAgenda}`).join("\n")],
    ["ACTIVE AGENDA", active ? `${active.id}: ${active.description.slice(0, 500)}` : "Whole-interview audit: cover all task agendas."],
    ["QUESTION BUDGET", `${d.round}/${questionLimit(d)} questions used overall; at most ${d.questionPolicy.maxPerAgenda} per agenda. Limits are caps, not targets. Settled agendas need no further questions.`],
    ["RECORDED EVIDENCE", "Model observations, not consent; excerpts only. Full records are protected and not available through file tools. Use the verified transcript excerpts below; omitted content is not evidence of an unanswered question. Preserve any unresolved uncertainty in closure instead of inventing a decision.\n" +
      (d.rounds.filter(round => round.evidence?.length).map(round => {
        const evidence = round.evidence!.join("; ")
        return `Round ${round.n}, agenda ${round.agendaID}: ${evidence.slice(0, 180)}${evidence.length > 180 ? " […]" : ""}`
      }).join("\n") || "none")],
  ]
}

const componentsText = (components: readonly Component[]) => components.length ? components.map(c => `- ${c.id}: ${c.description}`).join("\n") : "- none"
const listed = (items: readonly string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- none"

function panelFindings(worktree: string, wf: DeepInterviewWorkflow, d: DeepInterviewData): string[] {
  const pending = d.pendingPanel
  if (!pending) return []
  const out: string[] = []
  for (const persona of pending.personas) {
    const ref = pending.results[persona]
    const read = ref ? verifyReceiptRef(worktree, ref, { sessionID: wf.sessionID, workflowID: wf.id, kind: "panel", inputSha: pending.inputSha }) : undefined
    if (!read?.ok) throw new Error(`panel record for ${persona} does not verify`)
    const body = read.receipt.body
    const options = Array.isArray(body.suggested_options) ? (body.suggested_options as string[]).join(" | ") : ""
    out.push(`${persona}: ${String(body.finding)} (options: ${options})`)
  }
  if (pending.ontology) out.push("ontology escalation: ask what this thing really is, core entity versus supporting views")
  return out
}

/** The panel's shared input: every persona of one round receives exactly these bytes (plus its own prompt). */
export function panelContext(worktree: string, wf: DeepInterviewWorkflow, persona: Persona): Context {
  const d = dataOf(wf)
  const pending = d.pendingPanel!
  const round = d.rounds.find(r => r.n === pending.round)!
  return compose(DI_PANEL_PROMPTS[persona], [
    ["PANEL INPUT", `panel input sha: ${pending.inputSha}\nround: ${pending.round}\nambiguity: ${round.ambiguity} (band ${round.band}, threshold ${d.threshold})\ntriggers: ${pending.triggers.join(", ")}\nontology escalation requested: ${pending.ontology ? "yes" : "no"}\nweakest dimension: ${round.weakest ?? "unknown"}`],
    ["REQUEST", d.request],
    ["TOPOLOGY", `${d.type ?? "unknown"}\n${componentsText(d.topology.components)}`],
    ...agendaContext(d, round.agendaID),
    ["TRANSCRIPT", transcriptOf(worktree, wf, d)],
  ])
}

// ---------------------------------------------------------------------------------------------- parse helpers
const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/
function unfenced(output: string): string {
  const match = FENCE.exec(output.trim())
  return match ? match[1]! : output
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }
function only<K extends StageEvent["type"]>(events: StageEvent[], type: K): Parsed<Extract<StageEvent, { type: K }>> {
  const matches = events.filter(event => event.type === type)
  if (matches.length !== 1) return { ok: false, reason: `expected exactly one ${type} event, got ${matches.length}` }
  if (type !== "topology" && events.length !== 1) return { ok: false, reason: `expected only a ${type} event` }
  return { ok: true, value: matches[0] as Extract<StageEvent, { type: K }> }
}

// ---------------------------------------------------------------------------------------------- run
export type DiRunStatus = "done" | "stuck" | "blocked" | "stale" | "awaiting" | "exited" | "handed_off"
export type DiRunResult = { status: DiRunStatus; wf: DeepInterviewWorkflow | null; reason?: string; successor?: WorkflowEnvelope }
/**
 * The preset seam: called at the crystallize step with the interview in its done terminal form (the verified spec is
 * already on disk, not yet committed) and the events that complete it. A host that connects the interview to a successor
 * commits both in one handoff transaction; a refusal leaves the interview at crystallize, and the driver then commits the
 * plain completion so the verified specification is kept.
 */
export type DiHandoff = (done: DeepInterviewWorkflow, events: CommitEvent[]) => { ok: true; successor: WorkflowEnvelope } | { ok: false; text: string }
export type DiRunOptions = {
  signal?: AbortSignal
  handoff?: DiHandoff
  onStep?(wf: DeepInterviewWorkflow, step: DiStep): void
  /** Return `blocked` instead of running a step of this kind (lets a caller or test pause between steps). */
  stopBefore?: DiStep["kind"]
}

export async function runDeepInterview(runtime: ExecutionRuntime, sessionID: string, workflowID: string, io: DiIo, options: DiRunOptions = {}): Promise<DiRunResult> {
  const worktree = runtime.worktree
  let topologyNote: string | undefined
  let topologyDraft: { projectType: ProjectType; components: Component[] } | undefined
  let restateNote: string | undefined
  let restateDraft: string | undefined

  const commit = (wf: DeepInterviewWorkflow, event: DiEvent): CommitOutcome => commitDeepInterview(worktree, wf, apply(wf, event, worktree))

  /** Record one failed attempt durably; the committed counter (not process memory) decides when the item becomes stuck. */
  const fail = (wf: DeepInterviewWorkflow, item: string, reason: string, fatal = false): CommitOutcome | undefined =>
    commit(wf, { type: "attempt_failed", item, reason, fatal })

  const turn = async (wf: DeepInterviewWorkflow, role: TurnBinding["role"], prompt: StagePrompt, title: string, context: Context) => {
    const store = (() => { try { return getOwnedSession(worktree, sessionID) } catch { return undefined } })()
    const binding: TurnBinding = {
      workflowID: wf.id, revision: wf.lastSeq, kind: "deep-interview", stage: wf.stage, role, prompt,
      supervisorSessionID: sessionID, epoch: store?.epoch ?? null, ownerInstance: wf.owner.instance,
    }
    return runWorkflowTurn(runtime, binding, {
      title, text: context.text, budget: DI_TURN_BUDGET, label: "deep-interview", cancelCause: `deep-interview ${wf.stage} cancelled`,
      compact: { source: context.source, rebuild: context.rebuild },
    }, options.signal)
  }

  for (;;) {
    const current = committed(runtime, sessionID, workflowID)
    if (typeof current === "string") return { status: "stale", wf: null, reason: current }
    const step = nextStep(current, worktree)
    options.onStep?.(current, step)
    if (options.stopBefore === step.kind && step.kind !== "done") return { status: "blocked", wf: current, reason: `stopped before ${step.kind}` }
    if (step.kind === "done") return { status: "done", wf: current }
    if (step.kind === "stuck") return { status: "stuck", wf: current, reason: step.reason }
    if (step.kind === "blocked") return { status: current.phase === "cancelled" ? "exited" : "blocked", wf: current, reason: step.reason }
    const d = dataOf(current)

    // ---- human steps
    if (step.kind === "cap_choice") {
      const index = await io.choose(
        `${d.questionPolicy ? "Task agenda question budget" : "Maximum interview rounds"} (${step.round}) reached at ambiguity ${step.ambiguity} (threshold ${d.threshold}). Nothing is executed. Closure and restatement still run if you crystallize.${d.questionPolicy ? `\n${agendaContext(d)[0]![1]}\nOpen gaps: ${listed(d.gaps)}` : ""}`,
        ["Crystallize with current clarity", "Exit the interview"], options.signal)
      if (index === undefined) return { status: "awaiting", wf: current }
      const choice = index === 0 ? "crystallize" as const : "exit" as const
      const receiptRef = writeReceipt(worktree, { kind: "choice", wid: current.id, sid: current.sessionID, revision: current.lastSeq, action: "choice-cap", inputSha: choiceInputSha(current, "cap", step.round), body: { choice, round: step.round } })
      const outcome = commit(current, { type: "cap_decided", choice, receiptRef })
      if (!outcome.ok) return { status: "stale", wf: current, reason: outcome.text }
      continue
    }
    if (step.kind === "await_answer") {
      const question = readRound(worktree, current, step.round, "question", d.rounds.find(r => r.n === step.round)?.questionSha)
      const record = d.rounds.find(round => round.n === step.round)!
      const agendas = agendaProgress(d)
      const index = agendas.findIndex(item => item.id === record.agendaID)
      const agenda = d.questionPolicy && index >= 0 ? { id: agendas[index]!.id, description: agendas[index]!.description, index: index + 1,
        total: agendas.length, question: agendas[index]!.asked, limit: d.questionPolicy.maxPerAgenda } : undefined
      const answer = await io.readAnswer({ round: step.round, question, ...(agenda ? { agenda } : {}), ...readQuestionOptions(worktree, current, step.round) }, options.signal)
      if (answer === undefined) return { status: "awaiting", wf: current }
      if (answer.kind === "finish") {
        const refusal = earlyExitRefusal(current)
        if (refusal) { io.notice?.(refusal); continue }
        const ambiguity = finalAmbiguity(d)!
        const index = await io.choose(
          `Warning: ambiguity is ${ambiguity}, above the ${d.threshold} threshold. Finishing early still runs the closure audit and the restatement before the specification, and records the early exit.`,
          ["Finish early", "Keep interviewing"], options.signal)
        if (index === undefined) return { status: "awaiting", wf: current }
        if (index !== 0) continue
        const receiptRef = writeReceipt(worktree, { kind: "choice", wid: current.id, sid: current.sessionID, revision: current.lastSeq, action: "choice-early-exit", inputSha: choiceInputSha(current, "early-exit", d.round), body: { choice: "finish", round: d.round, ambiguity } })
        const outcome = commit(current, { type: "early_exit_confirmed", receiptRef })
        if (!outcome.ok) { io.notice?.(outcome.text); if (!/changed meanwhile|pending/.test(outcome.text)) continue; return { status: "stale", wf: current, reason: outcome.text } }
        continue
      }
      const text = answer.text
      if (!text.trim() || text.length > DI_MAX_ANSWER_CHARS) { io.notice?.(`An answer must be 1-${DI_MAX_ANSWER_CHARS} characters.`); continue }
      const answerSha = writeText(worktree, roundFileRelative(current.sessionID, current.id, step.round, "answer"), text)
      const outcome = commit(current, { type: "answer_recorded", round: step.round, answerSha, chars: text.length, source: "user" })
      if (!outcome.ok) return { status: "stale", wf: current, reason: outcome.text }
      continue
    }

    // ---- model steps
    let item: string
    let role: TurnBinding["role"]
    let prompt: StagePrompt
    let context: Context
    try {
      switch (step.kind) {
        case "topology":
          item = "topology"; role = "interviewer"; prompt = DI_TOPOLOGY_PROMPT
          context = compose(prompt, [
            ["REQUEST", d.request],
            ...(d.seed ? [["SEEDED AUTORESEARCH VERDICT", d.seed.raw] as const] : []),
            ...(topologyDraft ? [["PREVIOUS PROPOSAL", `${topologyDraft.projectType}\n${componentsText(topologyDraft.components)}`] as const] : []),
            ...(topologyNote ? [["OPERATOR NOTE", topologyNote] as const] : []),
          ])
          break
        case "question": {
          item = "question"; role = "interviewer"; prompt = DI_QUESTION_PROMPT
          const active = nextAgenda(d)
          const last = [...d.rounds].reverse().find(r => r.ambiguity !== undefined && (!active || r.agendaID === active.id))
          context = compose(prompt, [
            ["REQUEST", d.request], ["TOPOLOGY", `${d.type ?? "unknown"}\n${componentsText(d.topology.components)}`],
            ...agendaContext(d, active?.id),
            ...(d.attempt ? [["PREVIOUS QUESTION ATTEMPT", d.attempt.reasons.join("\n")] as const] : []),
            ["WEAKEST DIMENSION", last?.weakest ?? "goal (no round scored yet)"], ["PANEL FINDINGS", listed(panelFindings(worktree, current, d))],
            ["CLOSURE GAPS", listed(d.gaps)], ["TRANSCRIPT", transcriptOf(worktree, current, d)],
          ])
          break
        }
        case "scoring":
          item = "scoring"; role = "interviewer"; prompt = DI_SCORER_PROMPT
          context = compose(prompt, [
            ["REQUEST", d.request], ["PROJECT TYPE", d.type ?? "unknown"], ["TOPOLOGY", componentsText(d.topology.components)], ["TRANSCRIPT", transcriptOf(worktree, current, d)],
            ...agendaContext(d, d.rounds.at(-1)?.agendaID),
          ])
          break
        case "panel":
          item = `panel:${step.persona}`; role = step.persona; prompt = DI_PANEL_PROMPTS[step.persona]
          context = panelContext(worktree, current, step.persona)
          break
        case "closure":
          item = "closure"; role = "architect"; prompt = DI_CLOSURE_PROMPT
          context = compose(prompt, [
            ["LOCKED REQUEST", d.request], ["CONFIRMED COMPONENTS", componentsText(d.topology.components)], ["AMBIGUITY", `${finalAmbiguity(d)} (threshold ${d.threshold})`],
            ...agendaContext(d),
            ["EARLY EXIT", d.earlyExit ? `${d.earlyExit.reason} at round ${d.earlyExit.round}` : "none"], ["TRANSCRIPT", transcriptOf(worktree, current, d)],
          ])
          break
        case "restate":
          item = "restate"; role = "interviewer"; prompt = DI_RESTATEMENT_PROMPT
          context = compose(prompt, [
            ["LOCKED REQUEST", d.request], ["CONFIRMED COMPONENTS", componentsText(d.topology.components)], ["TRANSCRIPT", transcriptOf(worktree, current, d)],
            ...agendaContext(d),
            ...(restateDraft ? [["PREVIOUS RESTATEMENT", restateDraft] as const] : []), ...(restateNote ? [["OPERATOR NOTE", restateNote] as const] : []),
          ])
          break
        case "crystallize":
          item = "crystallize"; role = "interviewer"; prompt = DI_CRYSTALLIZE_PROMPT
          context = compose(prompt, [
            ["CONFIRMED GOAL", d.restatement?.goal ?? ""], ["CONFIRMED COMPONENTS", componentsText(d.topology.components)], ["OPEN GAPS", listed(d.gaps)],
            ...agendaContext(d),
            ["EARLY EXIT", d.earlyExit ? `${d.earlyExit.reason}: ambiguity ${d.earlyExit.ambiguity} (threshold ${d.threshold}); retain unresolved agendas and closure gaps` : "none"], ["TRANSCRIPT", transcriptOf(worktree, current, d)],
          ])
          break
        default: return { status: "blocked", wf: current, reason: "no model step" }
      }
    } catch (error) {
      const stuck = fail(current, step.kind, `context unavailable: ${(error as Error).message}`, true)
      if (stuck && !stuck.ok) return { status: "stale", wf: current, reason: stuck.text }
      continue
    }

    let result: Awaited<ReturnType<typeof turn>>
    try { result = await turn(current, role, prompt, `deep-interview ${current.stage}`, context) }
    catch (error) {
      // A model that cannot produce a bounded response is an attempt failure; lifecycle and fence errors stay fatal.
      const message = (error as Error).message ?? String(error)
      if (!/did not complete a response|exceeds the reserved conversation response budget/.test(message)) throw error
      const stuck = fail(current, item, message)
      if (stuck && !stuck.ok) return { status: "stale", wf: current, reason: stuck.text }
      continue
    }
    if (result.status === "diagnostic") return { status: "stale", wf: current, reason: result.reason }
    if (result.status === "stuck") {
      const stuck = fail(current, item, result.reason, true)
      if (stuck && !stuck.ok) return { status: "stale", wf: current, reason: stuck.text }
      continue
    }
    const outcome = await applyOutput(step, current, item, prompt, result.text)
    if (outcome === "continue") continue
    if (outcome.kind === "attempt") {
      const stuck = fail(current, item, outcome.reason)
      if (stuck && !stuck.ok) return { status: "stale", wf: current, reason: stuck.text }
      continue
    }
    if (outcome.kind === "stale") return { status: "stale", wf: current, reason: outcome.reason }
    if (outcome.kind === "awaiting") return { status: "awaiting", wf: current }
    if (outcome.kind === "handed_off") return { status: "handed_off", wf: current, successor: outcome.successor }
  }

  type Applied = "continue" | { kind: "attempt"; reason: string } | { kind: "stale"; reason: string } | { kind: "awaiting" } | { kind: "handed_off"; successor: WorkflowEnvelope }

  async function applyOutput(step: DiStep, wf: DeepInterviewWorkflow, item: string, prompt: StagePrompt, output: string): Promise<Applied> {
    const parsed = parseStageEventsFor(unfenced(output), "deep-interview", wf.stage)
    if (!parsed.ok) return { kind: "attempt", reason: parsed.reason }
    const d = dataOf(wf)
    const done = (outcome: CommitOutcome): Applied => (outcome.ok ? "continue" : { kind: "stale", reason: outcome.text })
    const ref = (kind: "choice" | "panel", action: string, inputSha: string, body: Record<string, unknown>) =>
      writeReceipt(worktree, { kind, wid: wf.id, sid: wf.sessionID, revision: wf.lastSeq, action, inputSha, body })
    const outputTag = sha256Text(output).slice(0, 8)
    switch (step.kind) {
      case "topology": {
        const one = only(parsed.events, "topology")
        if (!one.ok) return { kind: "attempt", reason: one.reason }
        topologyDraft = { projectType: one.value.project, components: one.value.components }
        const lines = `${one.value.project}\n${componentsText(one.value.components)}`
        const index = await io.choose(`Confirm the topology of this interview (once, before any question):\n${lines}`, ["Confirm topology", "Adjust topology"], options.signal)
        if (index === undefined) return { kind: "awaiting" }
        if (index !== 0) {
          const note = await io.readNote("What should change in the topology?", options.signal)
          if (note === undefined) return { kind: "awaiting" }
          topologyNote = note.slice(0, 2_000)
          return "continue"
        }
        const receiptRef = ref("choice", "choice-topology", topologyInputSha(one.value.project, one.value.components), { choice: "confirm", projectType: one.value.project, components: one.value.components })
        return done(commit(wf, { type: "topology_confirmed", projectType: one.value.project, components: one.value.components, receiptRef }))
      }
      case "question": {
        const one = only(parsed.events, "question")
        if (!one.ok) return { kind: "attempt", reason: one.reason }
        const round = step.round
        const questionKey = one.value.text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, " ").trim()
        const event: DiEvent = { type: "question_asked", round, questionSha: sha256Text(one.value.text), questionKey }
        const built = reduce(wf, event, { worktree })
        if (!built.ok) return { kind: "attempt", reason: built.text }
        const questionSha = writeText(worktree, roundFileRelative(wf.sessionID, wf.id, round, "question"), one.value.text)
        if (one.value.options) {
          writeText(worktree, questionOptionsRelative(wf.sessionID, wf.id, round), JSON.stringify({ options: one.value.options, ...(one.value.recommended === undefined ? {} : { recommended: one.value.recommended }) }))
        }
        return done(commit(wf, { ...event, questionSha }))
      }
      case "scoring": {
        const one = only(parsed.events, "score")
        if (!one.ok) return { kind: "attempt", reason: one.reason }
        const s = one.value
        const scores = { goal: s.goal, constraints: s.constraints, criteria: s.criteria, ...(s.context === undefined ? {} : { context: s.context }) }
        const built = reduce(wf, { type: "scores_recorded", round: step.round, scores, weakest: s.weakest, shapeChange: s.shape_change === true, evidence: s.evidence }, { worktree })
        if (!built.ok) return { kind: "attempt", reason: built.text }
        return done(commit(wf, { type: "scores_recorded", round: step.round, scores, weakest: s.weakest, shapeChange: s.shape_change === true, evidence: s.evidence }))
      }
      case "panel": {
        const one = only(parsed.events, "panel_finding")
        if (!one.ok) return { kind: "attempt", reason: one.reason }
        const pending = step.pending
        const f = one.value
        const receiptRef = ref("panel", `panel-r${pending.round}-${step.persona}-${outputTag}`, pending.inputSha, {
          round: pending.round, persona: step.persona, promptSha: prompt.sha256, outputSha: sha256Text(output), finding: f.finding, rationale: f.rationale, suggested_options: f.suggested_options, confidence: f.confidence,
        })
        return done(commit(wf, { type: "panel_result", persona: step.persona, receiptRef }))
      }
      case "closure": {
        const one = only(parsed.events, "closure")
        if (!one.ok) return { kind: "attempt", reason: one.reason }
        if (one.value.pass && one.value.gaps.length > 0) return { kind: "attempt", reason: "closure passed but listed gaps" }
        const agendaIDs = one.value.agenda_ids
        if (d.questionPolicy && !one.value.pass && !agendaIDs?.length) return { kind: "attempt", reason: "failed closure must name the task agendas needing clarification in agenda_ids" }
        if (agendaIDs?.some(id => !d.topology.components.some(component => component.id === id)) || (one.value.pass && agendaIDs?.length)) return { kind: "attempt", reason: "closure agenda targets must name confirmed unresolved task agendas" }
        const targets = agendaIDs === undefined ? {} : { agendaIDs }
        const receiptRef = ref("panel", `closure-r${d.round}-${outputTag}`, closureInputSha(wf, d), { round: d.round, pass: one.value.pass, gaps: one.value.gaps, ...targets, promptSha: prompt.sha256, outputSha: sha256Text(output) })
        return done(commit(wf, { type: "closure_result", pass: one.value.pass, gaps: one.value.gaps, ...targets, receiptRef }))
      }
      case "restate": {
        const one = only(parsed.events, "restatement")
        if (!one.ok) return { kind: "attempt", reason: one.reason }
        const goal = one.value.goal
        restateDraft = goal
        const afterLimit = d.earlyExit !== undefined || d.round >= questionLimit(d)
        const choices = afterLimit ? ["Yes, crystallize", "Adjust wording"] : ["Yes, crystallize", "Adjust wording", "Missing scope"]
        const index = await io.choose(`${goal}\nIf someone read only this line, would they reach the same outcome you have in mind?`, choices, options.signal)
        if (index === undefined) return { kind: "awaiting" }
        if (index === 0) {
          const receiptRef = ref("choice", "choice-restate", restatementInputSha(goal), { choice: "yes", goal })
          return done(commit(wf, { type: "restatement_confirmed", goal, receiptRef }))
        }
        if (index === 1) {
          const note = await io.readNote("How should the wording change?", options.signal)
          if (note === undefined) return { kind: "awaiting" }
          restateNote = note.slice(0, 2_000)
          return "continue"
        }
        const receiptRef = ref("choice", "choice-missing-scope", choiceInputSha(wf, "missing-scope", d.round), { choice: "missing-scope", goal })
        return done(commit(wf, { type: "restatement_missing_scope", receiptRef }))
      }
      case "crystallize": {
        const one = only(parsed.events, "message")
        if (!one.ok) return { kind: "attempt", reason: one.reason }
        const relative = specRelative(wf.sessionID, wf.id)
        const sha256Spec = writeText(worktree, relative, renderSpec(wf, d, one.value.text, Date.now()))
        const written: DiEvent = { type: "spec_written", path: relative, sha256: sha256Spec }
        if (options.handoff) {
          const built = reduce(wf, written, { worktree })
          if (!built.ok) return { kind: "attempt", reason: built.text }
          const handed = options.handoff({ ...built.wf, lastSeq: wf.lastSeq }, built.events)
          if (handed.ok) return { kind: "handed_off", successor: handed.successor }
          // A fault after the index publish can report failure for a handoff that did commit: the committed state decides.
          const after = readCommitted(worktree)
          if (after.state === "ok" && after.wf.kind === "ralplan" && after.wf.lineage?.predecessor.id === wf.id) return { kind: "handed_off", successor: after.wf }
          io.notice?.(`Connecting to ralplan was refused: ${handed.text}. The verified specification is kept.`)
        }
        return done(commit(wf, written))
      }
      default: return { kind: "attempt", reason: `${item} has no model output handler` }
    }
  }
}

// ---------------------------------------------------------------------------------------------- choices
export type ChoiceResult = { ok: true; wf: DeepInterviewWorkflow } | { ok: false; text: string }

/** Retry after an attempt-failure stuck: resumes the same stage with a fresh attempt budget. */
export function retryDeepInterview(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string, expectedRevision: number): ChoiceResult {
  const current = committed(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the retry is stale" }
  const outcome = commitDeepInterview(runtime.worktree, current, apply(current, { type: "retry" }, runtime.worktree))
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

// ---------------------------------------------------------------------------------------------- view
export type DiView = {
  stage: string
  phase: string
  round: number
  ambiguity?: number
  band?: string
  threshold: number
  thresholdSource: string
  agendas: ReturnType<typeof agendaProgress>
  questionLimit: number
  panel: Array<{ persona: Persona; state: "verified" | "missing" | "incomplete" }>
  earlyExit?: string
  /** Recomputed from disk: every panel/closure/choice record the interview rests on. */
  evidence: string
  evidenceOk: boolean
  line: string
}

/** Truth-first display: panel state is recomputed from the receipts on disk on every call; nothing stored is trusted. */
export function deepInterviewView(wf: DeepInterviewWorkflow, worktree: string): DiView {
  const d = dataOf(wf)
  const last = [...d.rounds].reverse().find(r => r.ambiguity !== undefined)
  const panel = (d.pendingPanel?.personas ?? []).map(persona => {
    const pending = d.pendingPanel!
    const ref = pending.results[persona]
    if (ref === undefined) return { persona, state: "missing" as const }
    const read = verifyReceiptRef(worktree, ref, { sessionID: wf.sessionID, workflowID: wf.id, kind: "panel", inputSha: pending.inputSha })
    return { persona, state: read.ok && read.receipt.body.round === pending.round && read.receipt.body.persona === persona ? "verified" as const : "incomplete" as const }
  })
  const incomplete = panel.filter(item => item.state === "incomplete").map(item => item.persona)
  const check = deepInterviewEvidence(worktree, wf)
  const marker = check.problems.length ? " · incomplete records" : ""
  const ambiguity = finalAmbiguity(d)
  const line = `deep-interview · ${wf.stage} · ${wf.phase}${ambiguity !== undefined ? ` · ambiguity ${ambiguity} (${bandOf(ambiguity, d.threshold)})` : ""}${incomplete.length ? ` · incomplete panel records: ${incomplete.join(", ")}` : ""}${marker}`
  return {
    stage: wf.stage, phase: wf.phase, round: d.round, ...(last ? { ambiguity: finalAmbiguity(d), band: bandOf(finalAmbiguity(d)!, d.threshold) } : {}), threshold: d.threshold,
    agendas: d.questionPolicy ? agendaProgress(d) : [], questionLimit: questionLimit(d),
    thresholdSource: d.thresholdSource, panel, evidence: evidenceSummary(check), evidenceOk: check.problems.length === 0, ...(d.earlyExit ? { earlyExit: `${d.earlyExit.reason} at round ${d.earlyExit.round}` } : {}), line,
  }
}

/** The verified specification of a finished interview (path and hash re-verified from disk), or an explanation. */
export function verifiedSpec(worktree: string, wf: DeepInterviewWorkflow): { ok: true; path: string; sha256: string } | { ok: false; reason: string } {
  const ref = wf.artifacts.find(item => item.key === "spec.md")
  if (wf.phase !== "done" || !ref?.sha256) return { ok: false, reason: "the interview has no recorded specification" }
  const evidence = deepInterviewEvidence(worktree, wf)
  if (evidence.problems.length > 0) return { ok: false, reason: `interview evidence ${evidenceSummary(evidence)}` }
  const read = readArtifactBytes(resolve(worktree, ref.path))
  if (!read.ok) return { ok: false, reason: `spec.md is ${read.reason}` }
  return sha256(read.bytes) === ref.sha256 ? { ok: true, path: ref.path, sha256: ref.sha256 } : { ok: false, reason: "spec.md hash mismatch" }
}

