// Shared local OpenJev transport rules for the skill router and memory recall: literal HTTP loopback root only,
// no credentials/query/hash, redirects refused by the caller, and a bounded JSON response body.
import { z } from "zod"

export const JEV_ENDPOINT_RULE = "loopback-literal http://127.0.0.1 or http://[::1] root without credentials, query or hash"

/** The `/v1/systemone` URL for an allowed endpoint, or null (the configured URL is never echoed: it may carry credentials). */
export function jevSystemOneUrl(endpoint: string): URL | null {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null
    return new URL("/v1/systemone", url)
  } catch {
    return null
  }
}

export async function boundedJson(response: Response, maxBytes = 65536): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (; ;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error("oversized")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => { })
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** One `choice` answer under `answers[question]`. */
export function choiceAnswerSchema(question: string) {
  return z.object({
    answers: z.object({
      [question]: z.object({
        type: z.literal("choice"), choice: z.string(),
        probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
        confidence: z.number().finite().min(0).max(1),
      }),
    }),
  })
}

/** The distribution must cover exactly the asked labels and sum to 1, and the choice must be one of them. */
export function validDistribution(labels: readonly string[], choice: string, probabilities: Record<string, number>): boolean {
  return Object.keys(probabilities).length === labels.length && labels.every((label) => Object.hasOwn(probabilities, label))
    && labels.includes(choice)
    && Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) <= 0.001
}
