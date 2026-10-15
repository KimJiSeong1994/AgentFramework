// Deep-interview completion evidence (P6a critic fix, W1/W7). Every receipt the interview's completion rests on is
// re-verified from disk, bound to its workflow, kind, round, persona and input hash: each completed panel round (kept in
// `data.panels`), the topology, closure, restatement and early-exit/cap choices. Used in the commit transaction at
// `spec_written`, in the handoff predecessor check, and by every display (`verifiedSpec`, status): a deleted, edited or
// wrongly bound receipt makes the interview incomplete and refuses the commit.
import { createHash } from "node:crypto"
import { dataOf } from "./deep-interview-data.ts"
import { verifyReceiptRef } from "./receipts.ts"
import type { DeepInterviewWorkflow } from "./types.ts"

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

export type EvidenceCheck = { problems: string[]; checked: number }

export function deepInterviewEvidence(worktree: string, wf: Pick<DeepInterviewWorkflow, "id" | "sessionID" | "data">): EvidenceCheck {
  const problems: string[] = []
  let checked = 0
  let d: ReturnType<typeof dataOf>
  try { d = dataOf(wf) } catch { return { problems: ["interview state is unreadable"], checked } }
  const bind = { sessionID: wf.sessionID, workflowID: wf.id }
  const check = (label: string, ref: string | undefined, expect: { kind: "panel" | "choice"; inputSha?: string; round?: number; persona?: string }): void => {
    checked++
    if (!ref) { problems.push(`${label}: no receipt recorded`); return }
    const read = verifyReceiptRef(worktree, ref, { ...bind, kind: expect.kind, ...(expect.inputSha ? { inputSha: expect.inputSha } : {}) })
    if (!read.ok) { problems.push(`${label}: ${read.reason}`); return }
    if (expect.round !== undefined && read.receipt.body.round !== expect.round) problems.push(`${label}: receipt is bound to another round`)
    if (expect.persona !== undefined && read.receipt.body.persona !== expect.persona) problems.push(`${label}: receipt is bound to another persona`)
  }
  if (d.topology.confirmed) {
    check("topology choice", d.topology.receiptRef, { kind: "choice", ...(d.type ? { inputSha: sha(JSON.stringify({ projectType: d.type, components: d.topology.components })) } : {}) })
  }
  const histories = [...d.panels]
  if (d.pendingPanel && !histories.some(item => item.round === d.pendingPanel!.round) && Object.keys(d.pendingPanel.results).length === d.pendingPanel.personas.length) {
    histories.push({ round: d.pendingPanel.round, inputSha: d.pendingPanel.inputSha, personas: d.pendingPanel.personas, results: d.pendingPanel.results })
  }
  for (const panel of histories) {
    for (const persona of panel.personas) check(`round ${panel.round} ${persona} panel record`, panel.results[persona], { kind: "panel", inputSha: panel.inputSha, round: panel.round, persona })
  }
  if (d.closure) check(`round ${d.closure.round} closure`, d.closure.receiptRef, { kind: "panel", round: d.closure.round })
  if (d.restatement) check("restatement choice", d.restatement.receiptRef, { kind: "choice", inputSha: sha(d.restatement.goal) })
  if (d.earlyExit) check(`${d.earlyExit.reason} decision`, d.earlyExit.receiptRef, { kind: "choice" })
  return { problems, checked }
}

/** One-line summary for displays: `ok`, or `incomplete: <first problems>`. */
export function evidenceSummary(check: EvidenceCheck): string {
  return check.problems.length === 0 ? `all ${check.checked} records verified` : `incomplete: ${check.problems.slice(0, 3).join("; ")}${check.problems.length > 3 ? `; +${check.problems.length - 3} more` : ""}`
}
