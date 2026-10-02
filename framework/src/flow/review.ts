// Advisory plan review (ralplan §5/§6 M1): a `reviewer` child session judges the submitted plan before it reaches
// pending_approval. Runs INSIDE the lca_flow tool call (main is blocked, so it never races a running queue).
// The only model text read is the verdict line (parsePlanVerdict, reuses the parseVerdict normalisation ideas);
// findings are advisory only — approval is the user's decision (/approve), never this reviewer's.
import type { HookDeps } from "../hooks/types.ts"
import { estimateTokens } from "../tokens.ts"
import { CHILD_TOOL_DENY, getQueue } from "../orchestration/queue.ts"
import { renderPlanMd, type Plan } from "./plan.ts"
import type { Workflow } from "./state.ts"

/** <= 350 est. tokens (asserted in test and by doctor D12c); the rendered plan is appended after this and capped separately. */
export const PLAN_REVIEW_TEMPLATE = `Review this plan before it goes to the user for approval. You are read-only: never edit, write or run commands.

Check: are the steps concrete and in a sane order? Does each step's files match what its verify command exercises? Is anything the goal needs missing, or present that it does not need? Are the risks real, not filler?

Reply with at most 5 short findings, one per line starting with "- " (omit if none), then a last line, exactly:
VERDICT: OKAY
or
VERDICT: ITERATE

OKAY: good enough to show the user, even if imperfect. ITERATE: one concrete, fixable problem worth another pass. Do not invent problems. Approval is the user's decision, not yours; you are advisory only.

Plan:
`

export type PlanReviewVerdict = "okay" | "iterate" | "none"
export type PlanReviewResult = { verdict: PlanReviewVerdict; findings: string[]; note?: "aborted" }

const PLAN_TOKEN_CAP = 1500

/** Trim the rendered plan from the end (whole lines) until it fits the review-prompt token budget. */
function capPlanText(text: string, maxTokens = PLAN_TOKEN_CAP): string {
  if (estimateTokens(text) <= maxTokens) return text
  const lines = text.split("\n")
  while (lines.length > 4 && estimateTokens(lines.join("\n")) > maxTokens) lines.pop()
  return lines.join("\n") + "\n… (truncated)"
}

/**
 * Verdict contract: the last line starting with (optionally) "VERDICT:" then one of OKAY|ACCEPT(ED)|승인 (okay) or
 * ITERATE|REJECT(ED)|거부 (iterate); anything else is `none` (never silently accepted). Up to 5 "- " findings.
 */
export function parsePlanVerdict(text: string): { verdict: PlanReviewVerdict; findings: string[] } {
  const rawLines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
  const findings = rawLines
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .slice(0, 5)
  const re = /^(?:verdict[\s*_`]*[:：]?)?\s*[*_`]*(okay|accept(?:ed)?|iterate|reject(?:ed)?|승인|거부)(?![A-Za-z])/i
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const stripped = rawLines[i]!.replace(/^[\s*_`#>\-]+/, "")
    const m = re.exec(stripped)
    if (!m) continue
    const word = m[1]!.toLowerCase()
    if (word === "okay" || word.startsWith("accept") || word === "승인") return { verdict: "okay", findings }
    if (word === "iterate" || word.startsWith("reject") || word === "거부") return { verdict: "iterate", findings }
  }
  return { verdict: "none", findings }
}

// ---------------------------------------------------------------- tool-call cap (reviewer child sessions only)
// tool-before.ts consults this for a session it did not create; keyed by session id, cleared when the review ends.
const reviewToolCalls = new Map<string, number>()

export function markReviewSession(sessionID: string): void {
  reviewToolCalls.set(sessionID, 0)
}
export function clearReviewSession(sessionID: string): void {
  reviewToolCalls.delete(sessionID)
}
export function isReviewSession(sessionID: string): boolean {
  return reviewToolCalls.has(sessionID)
}

/** tool.execute.before for a marked review session: increments the count, returns a refusal reason past the cap. */
export function reviewToolCapProblem(sessionID: string, max: number): string | null {
  const n = (reviewToolCalls.get(sessionID) ?? 0) + 1
  reviewToolCalls.set(sessionID, n)
  return n > max ? "give your verdict now" : null
}

// ---------------------------------------------------------------- child session

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
    .map((p: any) => p.text as string)
    .join("\n")
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

async function abortSession(deps: HookDeps, sessionID: string): Promise<void> {
  try {
    await (deps.client as any).session.abort({ path: { id: sessionID } })
  } catch (e) {
    deps.log("plan review: child abort failed", { sessionID, error: (e as Error).message })
  }
}

/**
 * Run the advisory plan review. Never throws: a session-create/prompt failure, an aborted child or a wall-clock
 * timeout all resolve to `{ verdict: "none", findings: [], note: "aborted" }` (T8 — the plan already passed the
 * code gates, so the user decides). Refuses (returns `none`, no child created) while the owning session's queue is
 * running, so a review never races a running queue.
 */
export async function runPlanReview(deps: HookDeps, wf: Workflow, plan: Plan, signal?: AbortSignal): Promise<PlanReviewResult> {
  if (getQueue(deps).isRunning(wf.sessionID)) return { verdict: "none", findings: [] }
  if (signal?.aborted) return { verdict: "none", findings: [], note: "aborted" }

  const rendered = capPlanText(renderPlanMd(wf.id, plan))
  const text = `${PLAN_REVIEW_TEMPLATE}\n${rendered}`
  const session = (deps.client as any).session
  const ttlMs = deps.config.delegate.review_ttl_ms

  let sessionID: string | undefined
  try {
    const created = await session.create({ body: { parentID: wf.sessionID, title: `lca plan review: ${wf.id}` } })
    sessionID = created?.data?.id
    if (!sessionID) {
      deps.log("plan review: session.create failed", { error: describeError(created?.error) })
      return { verdict: "none", findings: [], note: "aborted" }
    }
  } catch (e) {
    deps.log("plan review: session.create threw", { error: (e as Error).message })
    return { verdict: "none", findings: [], note: "aborted" }
  }

  markReviewSession(sessionID)
  try {
    const body: Record<string, unknown> = { agent: "reviewer", tools: CHILD_TOOL_DENY, parts: [{ type: "text", text }] }
    const model = deps.config.models.reviewer
    if (model) {
      const [providerID, ...rest] = model.split("/")
      if (providerID && rest.length) body.model = { providerID, modelID: rest.join("/") }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    // TTL and the tool call's abort (Esc) both end the review as T8 ("aborted"); the child session is aborted too.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ttlMs)
      if (signal) {
        onAbort = () => resolve("timeout")
        signal.addEventListener("abort", onAbort, { once: true })
      }
    })
    try {
      const raced = await Promise.race([session.prompt({ path: { id: sessionID }, body }), timeout])
      if (raced === "timeout") {
        await abortSession(deps, sessionID)
        return { verdict: "none", findings: [], note: "aborted" }
      }
      const res: any = raced
      if (res?.error) {
        deps.log("plan review: prompt error", { error: describeError(res.error) })
        return { verdict: "none", findings: [], note: "aborted" }
      }
      const data = res?.data ?? res
      const info = data?.info
      if (info?.error) {
        deps.log("plan review: child errored", { error: describeError(info.error) })
        return { verdict: "none", findings: [], note: "aborted" }
      }
      return parsePlanVerdict(extractText(data?.parts))
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener("abort", onAbort)
    }
  } catch (e) {
    deps.log("plan review: child prompt threw", { error: (e as Error).message })
    return { verdict: "none", findings: [], note: "aborted" }
  } finally {
    clearReviewSession(sessionID)
  }
}
