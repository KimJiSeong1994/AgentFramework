// Deep-interview state schema (P6a S2): constants, data types and the strict reader. A leaf module (no registry or
// engine imports) so the registry's kind parser can validate committed `data` without an import cycle.
import type { DeepInterviewWorkflow } from "./types.ts"

export const DI_THRESHOLD = 0.05
export const DI_THRESHOLD_SOURCE = "otter-default"
export const DI_DEFAULT_THRESHOLD = 0.20
export const DI_MAX_ROUNDS = 100
export const DI_EARLY_EXIT_ROUND = 3
export const DI_MAX_ANSWER_CHARS = 10_000
export const DI_MAX_ATTEMPTS = 2
export const DI_REQUEST_MAX = 4_000
export const DI_ONTOLOGY_ROUND = 8
export const DI_STALL_SPREAD = 0.05

export const PANEL_PERSONAS = ["researcher", "contrarian", "simplifier", "architect"] as const
export type Persona = (typeof PANEL_PERSONAS)[number]
export const BASE_PERSONAS: readonly Persona[] = ["researcher", "contrarian", "simplifier"]

export const BANDS = ["initial", "progress", "refined", "ready"] as const
export type Band = (typeof BANDS)[number]
export type ProjectType = "greenfield" | "brownfield"
export type Dimensions = { goal: number; constraints: number; criteria: number; context?: number }
export type Component = { id: string; description: string }


// ------------------------------------------------------------------------------------------------ data
export type RoundRecord = {
  n: number
  questionSha: string
  answerSha?: string
  scores?: Dimensions
  weakest?: string
  ambiguity?: number
  band?: Band
  shapeChange?: boolean
  /** Code-selected task agenda; absent on pre-agenda interviews. */
  agendaID?: string
  questionKey?: string
  /** Model observations grounded in the transcript; never user approval. */
  evidence?: string[]
}

export type PendingPanel = {
  round: number
  inputSha: string
  triggers: string[]
  personas: Persona[]
  ontology: boolean
  /** persona -> verified receipt reference */
  results: Partial<Record<Persona, string>>
}

/** A completed panel kept after `pendingPanel` is dropped: the record the completion re-check verifies again (bounded: <=100 rounds x 4 personas). */
export type PanelHistory = { round: number; inputSha: string; personas: Persona[]; results: Partial<Record<Persona, string>> }

export type DeepInterviewData = {
  v: 1
  request: string
  /** Optional productification seed from a verified autoresearch verdict. Display/context only; verified by the handoff. */
  seed?: {
    source: "autoresearch"
    verdictPath: string
    verdictSha: string
    status: "conclusive" | "inconclusive"
    evidence: unknown[]
    caveats: string[]
    raw: string
  }
  type?: ProjectType
  threshold: number
  thresholdSource: string
  /** Absent on legacy interviews: preserve their original threshold and 100-round contract. */
  questionPolicy?: { maxRounds: number; maxPerAgenda: number }
  round: number
  topology: { confirmed: boolean; components: Component[]; receiptRef?: string }
  rounds: RoundRecord[]
  pendingPanel?: PendingPanel
  /** Every completed panel, kept for the completion re-check and the truth display. */
  panels: PanelHistory[]
  /** Consecutive failed attempts of one item; any other transition clears it, so Escape+/continue or a restart cannot reset the limit. */
  attempt?: { item: string; count: number; reasons: string[] }
  lateralReviews: number
  panelFailures: number
  stuck?: { item: string; reason: string; evidence: string[] }
  closure?: { round: number; pass: boolean; receiptRef: string }
  closureOverrides: Array<{ round: number; gaps: string[] }>
  /** Open gaps folded into the next question (closure gaps, missing scope). */
  gaps: string[]
  /** Closure-owned task targets, not a model-supplied permission to reopen other agendas. */
  reopenAgendaIDs?: string[]
  restatement?: { goal: string; receiptRef: string }
  earlyExit?: { round: number; ambiguity: number; reason: "finish" | "cap"; receiptRef: string }
  cap?: { round: number; ambiguity: number; decided: boolean }
  specRef?: { path: string; sha256: string }
}

export function newData(request: string): DeepInterviewData {
  return {
    v: 1, request: request.slice(0, DI_REQUEST_MAX), threshold: DI_DEFAULT_THRESHOLD, thresholdSource: "otter-agenda-default", round: 0,
    questionPolicy: { maxRounds: 12, maxPerAgenda: 2 },
    topology: { confirmed: false, components: [] }, rounds: [], panels: [], lateralReviews: 0, panelFailures: 0, closureOverrides: [], gaps: [],
  }
}

export const questionLimit = (d: DeepInterviewData): number => d.questionPolicy?.maxRounds ?? DI_MAX_ROUNDS

export function agendaProgress(d: DeepInterviewData) {
  return d.topology.components.map(component => {
    const rounds = d.rounds.filter(round => round.agendaID === component.id)
    const last = rounds.findLast(round => round.ambiguity !== undefined)
    const status = last?.ambiguity !== undefined && last.ambiguity <= d.threshold ? "ready" as const
      : rounds.length >= (d.questionPolicy?.maxPerAgenda ?? DI_MAX_ROUNDS) ? "exhausted" as const : "pending" as const
    return { ...component, asked: rounds.length, ambiguity: last?.ambiguity, status }
  })
}

export function nextAgenda(d: DeepInterviewData) {
  if (!d.questionPolicy || d.round >= questionLimit(d)) return undefined
  const agendas = agendaProgress(d)
  if (d.gaps.length && d.reopenAgendaIDs) return agendas.find(item => d.reopenAgendaIDs!.includes(item.id) && item.asked < d.questionPolicy!.maxPerAgenda)
  return agendas.find(item => item.status === "pending")
    ?? (d.gaps.length ? agendas.find(item => item.asked < d.questionPolicy!.maxPerAgenda) : undefined)
}

export function questionBudgetReached(d: DeepInterviewData): boolean {
  return d.round >= questionLimit(d) || (d.questionPolicy !== undefined && nextAgenda(d) === undefined)
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** Strict parser for the registry: `{}` or a complete v1 record. */
export function parseDeepInterviewData(value: unknown): DeepInterviewData {
  return dataOf({ data: value as DeepInterviewWorkflow["data"] })
}

/** Read of a committed envelope's `data`; the registry parser only proves it is an object. */
export function dataOf(wf: Pick<DeepInterviewWorkflow, "data">): DeepInterviewData {
  const d = wf.data as Record<string, unknown>
  // An empty object is the not-yet-started state (the generic substrate commits planning kinds with `data: {}`).
  if (isObject(d) && Object.keys(d).length === 0) return newData("")
  if (!isObject(d) || d.v !== 1 || typeof d.request !== "string" || typeof d.threshold !== "number" || typeof d.thresholdSource !== "string" ||
    !Number.isSafeInteger(d.round) || (d.round as number) < 0 || (d.round as number) > DI_MAX_ROUNDS || !isObject(d.topology) || typeof d.topology.confirmed !== "boolean" ||
    !Array.isArray(d.topology.components) || !Array.isArray(d.rounds) || !Array.isArray(d.closureOverrides) || !Array.isArray(d.gaps) ||
    !Number.isSafeInteger(d.lateralReviews) || !Number.isSafeInteger(d.panelFailures) ||
    (d.type !== undefined && d.type !== "greenfield" && d.type !== "brownfield")) throw new Error("invalid deep-interview state")
  if (d.panels !== undefined && (!Array.isArray(d.panels) || d.panels.length > DI_MAX_ROUNDS)) throw new Error("invalid deep-interview state")
  if (d.questionPolicy !== undefined) {
    const p = d.questionPolicy
    if (!isObject(p) || !Number.isSafeInteger(p.maxRounds) || (p.maxRounds as number) < 1 || (p.maxRounds as number) > 12 ||
      !Number.isSafeInteger(p.maxPerAgenda) || (p.maxPerAgenda as number) < 1 || (p.maxPerAgenda as number) > 2 ||
      !Number.isFinite(d.threshold) || d.threshold < 0 || d.threshold > 1 || (d.round as number) > (p.maxRounds as number)) throw new Error("invalid deep-interview question policy")
    const ids = new Set<string>()
    for (const component of d.topology.components) {
      if (!isObject(component) || typeof component.id !== "string" || !component.id || ids.has(component.id) || typeof component.description !== "string") throw new Error("invalid deep-interview agenda")
      ids.add(component.id)
    }
    if (d.reopenAgendaIDs !== undefined && (!Array.isArray(d.reopenAgendaIDs) || d.reopenAgendaIDs.length === 0 ||
      new Set(d.reopenAgendaIDs).size !== d.reopenAgendaIDs.length || d.reopenAgendaIDs.some(id => typeof id !== "string" || !ids.has(id)))) throw new Error("invalid deep-interview closure agendas")
    if (d.rounds.length !== d.round || d.rounds.some((round, index) => !isObject(round) || round.n !== index + 1 ||
      typeof round.agendaID !== "string" || !ids.has(round.agendaID) ||
      (round.questionKey !== undefined && (typeof round.questionKey !== "string" || round.questionKey.length > 2000)) ||
      (round.evidence !== undefined && (!Array.isArray(round.evidence) || round.evidence.length > 8 || !round.evidence.every(item => typeof item === "string" && item.length <= 500))))) throw new Error("invalid deep-interview agenda rounds")
    for (const id of ids) if (d.rounds.filter(round => (round as RoundRecord).agendaID === id).length > (p.maxPerAgenda as number)) throw new Error("deep-interview agenda budget exceeded")
  }
  if (d.seed !== undefined) {
    const s = d.seed as Record<string, unknown>
    if (!isObject(s) || s.source !== "autoresearch" || typeof s.verdictPath !== "string" || typeof s.verdictSha !== "string" ||
      (s.status !== "conclusive" && s.status !== "inconclusive") || !Array.isArray(s.evidence) || !Array.isArray(s.caveats) ||
      !s.caveats.every(item => typeof item === "string") || typeof s.raw !== "string" || s.raw.length > 32_000) {
      throw new Error("invalid deep-interview state")
    }
  }
  return (d.panels === undefined ? { ...d, panels: [] } : d) as unknown as DeepInterviewData
}

