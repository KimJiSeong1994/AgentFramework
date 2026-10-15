// Deep-interview state schema (P6a S2): constants, data types and the strict reader. A leaf module (no registry or
// engine imports) so the registry's kind parser can validate committed `data` without an import cycle.
import type { DeepInterviewWorkflow } from "./types.ts"

export const DI_THRESHOLD = 0.05
export const DI_THRESHOLD_SOURCE = "lca-default"
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
  restatement?: { goal: string; receiptRef: string }
  earlyExit?: { round: number; ambiguity: number; reason: "finish" | "cap"; receiptRef: string }
  cap?: { round: number; ambiguity: number; decided: boolean }
  specRef?: { path: string; sha256: string }
}

export function newData(request: string): DeepInterviewData {
  return {
    v: 1, request: request.slice(0, DI_REQUEST_MAX), threshold: DI_THRESHOLD, thresholdSource: DI_THRESHOLD_SOURCE, round: 0,
    topology: { confirmed: false, components: [] }, rounds: [], panels: [], lateralReviews: 0, panelFailures: 0, closureOverrides: [], gaps: [],
  }
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

