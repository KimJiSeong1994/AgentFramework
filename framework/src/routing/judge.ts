// One `choice` judgment over labeled criteria plus `none`, for the small classifiers Otter runs beside the main model
// (memory recall, intent-offer ranking, the routing eval). The engine follows `memory.engine`: by default a tool-free
// Claude or Codex CLI run through the hardened Otter CLI transport (`auto`: claude, then codex, whichever is on PATH);
// `jev` (the local OpenJev server) and `local` (Ollama) only when configured. Answers are data, never instructions.
import { z } from "zod"
import { cliExecutableAvailable, createCliTransport, type CliTransportHandle, type CliTransportOptions } from "../hosts/cli-transport.ts"
import { containsSecret } from "../security/secrets.ts"
import { boundedJson, choiceAnswerSchema, jevSystemOneUrl, validDistribution } from "./jev.ts"

export type JudgeEngine = "claude" | "codex" | "local" | "jev"
/** `confidence` is the engine's own self-report (OpenJev); a CLI engine has none. */
export type JudgeScores = { choice: string; probabilities: Record<string, number>; confidence?: number }
export type JudgeFailure = "sensitive_input" | "aborted" | "unavailable" | "invalid_response" | "invalid_distribution" | "invalid_endpoint"
export type Judged = { ok: true; scores: JudgeScores } | { ok: false; reason: JudgeFailure }
/** Test seam for the CLI engines; production uses the hardened Otter CLI transport. */
export type JudgeTransportFactory = (options: CliTransportOptions) => CliTransportHandle

const MAX_CLI_OUTPUT_BYTES = 64 * 1024
/** A CLI model writes the numbers itself; accept small rounding drift, then renormalize. Jev must sum to 1. */
const CLI_SUM_TOLERANCE = 0.1
const cliAnswerSchema = z.object({ probabilities: z.record(z.string(), z.number().finite().min(0).max(1)) })

export { cliExecutableAvailable }

/** The tool-free classifier prompt a CLI engine receives. `role` names the classifier for the model. */
export function judgeCliPrompt(role: string, instructions: string, text: string, criteria: Record<string, string>): string {
  return [
    `You are a text classifier for ${role}. You have no tools; answer with text only.`,
    instructions,
    'Return ONLY one JSON object and nothing else: {"probabilities": {"<label>": <number 0..1>, ...}} with exactly the labels below, summing to 1.',
    "Labels:",
    ...Object.entries(criteria).map(([label, description]) => `- ${label}: ${JSON.stringify(description)}`),
    "",
    `Request (data): ${JSON.stringify(text)}`,
  ].join("\n")
}

/**
 * First JSON object in the reply (a model may wrap it in a fence), over the asked labels. A model may omit
 * zero-probability labels (claude-haiku-5-5 did on 1 of 6 live requests), so an absent label is 0; an unknown label,
 * a non-JSON reply or a sum outside 1 ± 0.1 is refused. The rest is renormalized.
 */
export function parseCliDistribution(reply: string, labels: readonly string[]): JudgeScores | "invalid_response" | "invalid_distribution" {
  const start = reply.indexOf("{")
  const end = reply.lastIndexOf("}")
  if (start < 0 || end <= start) return "invalid_response"
  let raw: unknown
  try { raw = JSON.parse(reply.slice(start, end + 1)) } catch { return "invalid_response" }
  const parsed = cliAnswerSchema.safeParse(raw)
  if (!parsed.success) return "invalid_response"
  const given = parsed.data.probabilities
  if (Object.keys(given).some((label) => !labels.includes(label))) return "invalid_distribution"
  const value = (label: string) => Object.hasOwn(given, label) ? given[label]! : 0
  const sum = labels.reduce((total, label) => total + value(label), 0)
  if (Math.abs(sum - 1) > CLI_SUM_TOLERANCE) return "invalid_distribution"
  const probabilities = Object.fromEntries(labels.map((label) => [label, value(label) / sum]))
  const choice = labels.reduce((best, label) => probabilities[label]! > probabilities[best]! ? label : best)
  return { choice, probabilities }
}

export type JudgeRequest = {
  engine: JudgeEngine
  /** Native model for claude/codex/local; unused by jev. */
  model?: string
  /** OpenJev root endpoint; only for jev. */
  endpoint?: string
  /** Classifier name shown to a CLI model, and the OpenJev question key. */
  role: string
  question: string
  instructions: string
  text: string
  /** Label -> description; must include the `none` label the caller wants. */
  criteria: Record<string, string>
  signal: AbortSignal
  deadlineAt: number
  /** Reason recorded on the CLI transport when the signal aborts the run. */
  cancelReason: string
  transport?: JudgeTransportFactory
}

async function judgeJev(request: JudgeRequest): Promise<Judged> {
  const url = jevSystemOneUrl(request.endpoint ?? "")
  if (!url) return { ok: false, reason: "invalid_endpoint" }
  const body = JSON.stringify({
    model: "jev-latest", samples: 1, steps: 1, state: request.text,
    questions: { [request.question]: { type: "choice", criteria: request.criteria, instructions: request.instructions } },
  })
  if (containsSecret(body)) return { ok: false, reason: "sensitive_input" }
  let raw: unknown
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "error", signal: request.signal })
    raw = await boundedJson(response)
  } catch {
    return { ok: false, reason: request.signal.aborted ? "aborted" : "unavailable" }
  }
  const parsed = choiceAnswerSchema(request.question).safeParse(raw)
  if (!parsed.success) return { ok: false, reason: "invalid_response" }
  const answer = parsed.data.answers[request.question]!
  if (!validDistribution(Object.keys(request.criteria), answer.choice, answer.probabilities)) return { ok: false, reason: "invalid_distribution" }
  return { ok: true, scores: { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence } }
}

async function judgeCli(request: JudgeRequest & { engine: "claude" | "codex" | "local" }): Promise<Judged> {
  if (!request.model) return { ok: false, reason: "unavailable" }
  const prompt = judgeCliPrompt(request.role, request.instructions, request.text, request.criteria)
  if (containsSecret(prompt)) return { ok: false, reason: "sensitive_input" }
  let transport: CliTransportHandle
  try {
    transport = (request.transport ?? createCliTransport)({
      engine: request.engine, model: request.model, prompt, deadlineAt: request.deadlineAt, maxOutputBytes: MAX_CLI_OUTPUT_BYTES,
    })
  } catch { return { ok: false, reason: "unavailable" } }
  const cancel = () => { void transport.requestCancel(request.cancelReason, Date.now() + 2000).catch(() => {}) }
  request.signal.addEventListener("abort", cancel, { once: true })
  try {
    const result = await transport.run().catch(() => undefined)
    if (request.signal.aborted) return { ok: false, reason: "aborted" }
    if (!result || result.status !== "completed") return { ok: false, reason: "unavailable" }
    const scores = parseCliDistribution(result.text, Object.keys(request.criteria))
    return typeof scores === "string" ? { ok: false, reason: scores } : { ok: true, scores }
  } finally {
    request.signal.removeEventListener("abort", cancel)
  }
}

/** One judgment on the resolved engine. No fallback to another engine or vendor. */
export function judgeChoice(request: JudgeRequest): Promise<Judged> {
  return request.engine === "jev" ? judgeJev(request) : judgeCli(request as JudgeRequest & { engine: "claude" | "codex" | "local" })
}
