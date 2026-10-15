// Ralplan evidence (P6a S3): hash-recorded readable artifacts, write-once receipts and the disk-derived consensus check.
// Nothing here trusts a stored flag: consensus and its display line are recomputed from the plan file, the retained plan
// copy and the receipts on every call.
import { join, resolve } from "node:path"
import { durableWriteBytes } from "../state/durable.ts"
import { stateRoot } from "../state/store.ts"
import { readArtifactBytes, retainContentAddressed, sha256, verifyArtifact, workflowArtifactDirectory } from "./artifacts.ts"
import {
  joinReview, PLANNING_COMPLETE_TEXT, PLANNING_STUCK_MARKER, ralplanDataOf, RALPLAN_MAX_OPENERS, type Hashed, type RalplanWorkflow,
} from "./ralplan.ts"
import type { ArchitectResult, ArchitectStatus, CriticResult, RalplanData, RalplanIteration } from "./ralplan-data.ts"
import { verifyReceiptRef, writeReceipt, type Receipt } from "./receipts.ts"

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

/** `<worktree>/.lca/workflows/<sid>/<wid>/<key>` as a hash-recorded, worktree-relative artifact reference. */
export function writeReadable(worktree: string, wf: Pick<RalplanWorkflow, "sessionID" | "id" | "artifacts">, key: string, text: string): Hashed {
  if (!KEY_RE.test(key) || key.includes("..")) throw new TypeError("invalid artifact key")
  if (wf.artifacts.some(ref => ref.key === key)) throw new Error(`artifact ${key} is already committed; refusing overwrite`)
  const bytes = Buffer.from(text, "utf8")
  durableWriteBytes(join(workflowArtifactDirectory(worktree, wf.sessionID, wf.id), key), bytes)
  return { key, path: join(".lca", "workflows", wf.sessionID, wf.id, key), sha256: sha256(bytes) }
}

/** Verified read of a recorded artifact; a missing, edited or oversized file throws (never silently reused). */
export function readRecorded(worktree: string, wf: Pick<RalplanWorkflow, "artifacts">, key: string): string {
  const ref = wf.artifacts.find(item => item.key === key)
  if (!ref) throw new Error(`artifact ${key} is not recorded`)
  const verified = verifyArtifact(worktree, ref)
  if (verified.state !== "verified") throw new Error(`artifact ${key} is ${verified.state}: ${verified.reason}`)
  const read = readArtifactBytes(resolve(worktree, ref.path))
  if (!read.ok) throw new Error(`artifact ${key} is unreadable: ${read.reason}`)
  return read.bytes.toString("utf8")
}

const plansDirectory = (worktree: string, sid: string, wid: string) => join(stateRoot(worktree), "sessions", sid, "workflows", wid, "plans")

/** Write-once content-addressed copy of a plan beside the snapshot, outside the worktree a worker can edit. */
export function retainPlan(worktree: string, wf: Pick<RalplanWorkflow, "sessionID" | "id">, planText: string): string {
  const bytes = Buffer.from(planText, "utf8")
  return retainContentAddressed(plansDirectory(worktree, wf.sessionID, wf.id), bytes, "md", sha256(bytes))
}

// ---------------------------------------------------------------------------------------------- receipts
const laneAction = (role: "architect" | "critic", opener: number, output: string) => `${role}-o${opener}-${sha256(output).slice(0, 8)}`

/** Lane receipts bind the plan hash the CODE recorded for the opener; the model never names a hash. */
export function writeArchitectReceipt(
  worktree: string, wf: RalplanWorkflow, opener: number, planSha: string,
  verdict: { status: ArchitectStatus; decision: ArchitectResult["decision"]; findings: readonly string[] }, promptSha: string, output: string,
): string {
  return writeReceipt(worktree, {
    kind: "consensus", wid: wf.id, sid: wf.sessionID, revision: wf.lastSeq, action: laneAction("architect", opener, output), inputSha: planSha,
    body: { role: "architect", opener, planSha, status: verdict.status, decision: verdict.decision, findings: [...verdict.findings], promptSha },
  })
}

export function writeCriticReceipt(
  worktree: string, wf: RalplanWorkflow, opener: number, planSha: string,
  verdict: { verdict: CriticResult["verdict"]; findings: readonly string[] }, promptSha: string, output: string,
): string {
  return writeReceipt(worktree, {
    kind: "consensus", wid: wf.id, sid: wf.sessionID, revision: wf.lastSeq, action: laneAction("critic", opener, output), inputSha: planSha,
    body: { role: "critic", opener, planSha, verdict: verdict.verdict, findings: [...verdict.findings], promptSha },
  })
}

export function writeConsensusReceipt(worktree: string, wf: RalplanWorkflow, it: RalplanIteration): string {
  return writeReceipt(worktree, {
    kind: "consensus", wid: wf.id, sid: wf.sessionID, revision: wf.lastSeq, action: `consensus-o${it.n}`, inputSha: it.planSha,
    body: { role: "consensus", opener: it.n, planSha: it.planSha, architectRef: it.architect!.ref, criticRef: it.critic!.ref },
  })
}

export type ConsensusEvidence = { ok: true; iteration: RalplanIteration; architect: Receipt; critic: Receipt; consensus?: Receipt } | { ok: false; reason: string }

/**
 * Re-derive consensus from disk. Succeeds only when the join is clean, the plan file and its retained copy still hash to
 * the iteration's plan hash, both lane receipts exist bound to THAT hash with matching verdicts, and (when recorded) the
 * consensus receipt names exactly those two receipts. Used before committing consensus and on every display.
 */
export function verifyConsensusEvidence(worktree: string, wf: RalplanWorkflow, opener?: number): ConsensusEvidence {
  let data: RalplanData
  try { data = ralplanDataOf(wf) } catch { return { ok: false, reason: "ralplan state is malformed" } }
  const n = opener ?? data.consensus?.opener ?? data.openers
  const it = data.iterations[n - 1]
  if (!it) return { ok: false, reason: `opener ${n} does not exist` }
  const joined = joinReview(it)
  if (!joined.consensus || !it.architect || !it.critic) return { ok: false, reason: `no clean join: ${joined.reasons.join("; ")}` }
  const planRef = wf.artifacts.find(ref => ref.key === it.planKey)
  if (!planRef || planRef.sha256 !== it.planSha) return { ok: false, reason: "plan artifact is not recorded at the judged hash" }
  const plan = verifyArtifact(worktree, planRef)
  if (plan.state !== "verified") return { ok: false, reason: `plan artifact is ${plan.state}: ${plan.reason}` }
  const retained = readArtifactBytes(join(plansDirectory(worktree, wf.sessionID, wf.id), `${it.planSha}.md`))
  if (!retained.ok || sha256(retained.bytes) !== it.planSha) return { ok: false, reason: "retained plan copy is missing or changed" }
  const binding = { sessionID: wf.sessionID, workflowID: wf.id, kind: "consensus" as const, inputSha: it.planSha }
  const a = verifyReceiptRef(worktree, it.architect.ref, binding)
  if (!a.ok) return { ok: false, reason: `architect receipt: ${a.reason}` }
  const c = verifyReceiptRef(worktree, it.critic.ref, binding)
  if (!c.ok) return { ok: false, reason: `critic receipt: ${c.reason}` }
  const ab = a.receipt.body
  const cb = c.receipt.body
  if (ab.role !== "architect" || ab.opener !== n || ab.planSha !== it.planSha || ab.status !== it.architect.status || ab.decision !== it.architect.decision) return { ok: false, reason: "architect receipt disagrees with the recorded verdict" }
  if (cb.role !== "critic" || cb.opener !== n || cb.planSha !== it.planSha || cb.verdict !== it.critic.verdict) return { ok: false, reason: "critic receipt disagrees with the recorded verdict" }
  if (ab.planSha !== cb.planSha) return { ok: false, reason: "architect and critic receipts carry different plan hashes" }
  if (!data.consensus) return { ok: true, iteration: it, architect: a.receipt, critic: c.receipt }
  if (data.consensus.opener !== n || data.consensus.planSha !== it.planSha) return { ok: false, reason: "consensus names another opener or plan hash" }
  const k = verifyReceiptRef(worktree, data.consensus.ref, binding)
  if (!k.ok) return { ok: false, reason: `consensus receipt: ${k.reason}` }
  const kb = k.receipt.body
  if (kb.role !== "consensus" || kb.opener !== n || kb.planSha !== it.planSha || kb.architectRef !== it.architect.ref || kb.criticRef !== it.critic.ref) return { ok: false, reason: "consensus receipt names other lane receipts" }
  return { ok: true, iteration: it, architect: a.receipt, critic: c.receipt, consensus: k.receipt }
}

// ---------------------------------------------------------------------------------------------- display
/** `Architect CLEAR/APPROVE + Critic OKAY · execution pending`, recomputed from disk; undefined before consensus. */
export function consensusLine(worktree: string, wf: RalplanWorkflow): string | undefined {
  const data = ralplanDataOf(wf)
  if (!data.consensus) return undefined
  const evidence = verifyConsensusEvidence(worktree, wf)
  if (!evidence.ok) return `consensus unverified: ${evidence.reason}`
  const a = evidence.iteration.architect!
  const c = evidence.iteration.critic!
  const tail = wf.phase === "done" && data.choice?.kind === "stop_here" ? PLANNING_COMPLETE_TEXT : "execution pending"
  return `Architect ${a.status}/${a.decision} + Critic ${c.verdict} · ${tail}`
}

export type RalplanReview = { plan?: string; review: string }
/** Compact status view (truth-first: consensus is verified from disk, never read from a flag). */
export function ralplanReview(worktree: string, wf: RalplanWorkflow): RalplanReview {
  let data: RalplanData
  try { data = ralplanDataOf(wf) } catch { return { review: "ralplan state unreadable" } }
  const line = consensusLine(worktree, wf)
  if (line) {
    const pending = wf.artifacts.find(ref => ref.key === "pending-approval.md")?.path
    return { ...(pending ? { plan: pending } : {}), review: line }
  }
  if (data.stuck?.kind === "cap") {
    const best = wf.artifacts.find(ref => ref.key === "best-plan.md")?.path
    return { ...(best ? { plan: best } : {}), review: `${PLANNING_STUCK_MARKER}: ${data.openers} openers, no consensus; best plan kept (opener ${data.stuck.bestOpener ?? data.openers}); not executed` }
  }
  const it = data.iterations[data.iterations.length - 1]
  if (!it) return { review: `opener 0/${RALPLAN_MAX_OPENERS} · ${wf.stage}` }
  const a = it.architect ? `architect ${it.architect.status}/${it.architect.decision}` : "architect pending"
  const c = it.critic ? `critic ${it.critic.verdict}` : "critic pending"
  return { plan: it.planPath, review: `opener ${it.n}/${RALPLAN_MAX_OPENERS} · ${a} · ${c}${data.stuck ? ` · stuck: ${data.stuck.reason}` : ""}` }
}
