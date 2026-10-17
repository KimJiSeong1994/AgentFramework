// RepeatGuard: blocks the (limit+1)th identical (tool, args) call per session until one of them succeeds.
// Evidence: Gemma 26B re-issued the same failing `write` 13 times in a row (review §3).

const MAX_SIGNATURES_PER_SESSION = 50
const MAX_CALLS_PER_SESSION = 50
const ERROR_EXCERPT_CHARS = 240

type Entry = { count: number; lastError?: string }

export type RepeatCheck = { blocked: boolean; count: number; lastError?: string }

/** Stable JSON: object keys sorted recursively so `{a,b}` and `{b,a}` produce the same signature. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value === undefined ? null : value
}

export function signatureOf(tool: string, args: unknown): string {
  return `${tool}:${canonicalJson(args ?? {})}`
}

export function repeatBlockMessage(tool: string, count: number, lastError?: string): string {
  const why = lastError ? ` The previous attempts failed with: ${lastError}` : ""
  return `otter: blocked repeated call to ${tool} with identical arguments (${count}x).${why} Change the approach: read the error, use a different tool or different arguments.`
}

export function errorExcerpt(text: string | undefined, max = ERROR_EXCERPT_CHARS): string | undefined {
  if (!text) return undefined
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (!oneLine) return undefined
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine
}

export class RepeatGuard {
  private readonly limit: number
  /** sessionID -> signature -> entry (insertion ordered, bounded) */
  private readonly sessions = new Map<string, Map<string, Entry>>()
  /** sessionID -> callID -> signature (bounded) */
  private readonly calls = new Map<string, Map<string, string>>()

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  /**
   * Register an attempt. Returns blocked=true on the (limit+1)th identical call whose predecessors have
   * not succeeded. `callID` lets recordResult() find the signature later.
   */
  check(sessionID: string, tool: string, args: unknown, callID?: string): RepeatCheck {
    const sig = signatureOf(tool, args)
    const ring = this.ring(sessionID)
    const prev = ring.get(sig)
    const count = (prev?.count ?? 0) + 1
    const entry: Entry = { count, lastError: prev?.lastError }
    ring.delete(sig)
    ring.set(sig, entry)
    trimMap(ring, MAX_SIGNATURES_PER_SESSION)
    if (callID) {
      const calls = this.callMap(sessionID)
      calls.delete(callID)
      calls.set(callID, sig)
      trimMap(calls, MAX_CALLS_PER_SESSION)
    }
    return { blocked: count > this.limit, count, lastError: entry.lastError }
  }

  /** Success resets the signature's counter; failure remembers an excerpt of the error for the block message. */
  recordResult(sessionID: string, callID: string, ok: boolean, error?: string): void {
    const sig = this.calls.get(sessionID)?.get(callID)
    if (!sig) return
    const ring = this.sessions.get(sessionID)
    if (!ring) return
    if (ok) {
      ring.delete(sig)
      return
    }
    const entry = ring.get(sig)
    if (!entry) return
    // Our own block message must not overwrite the underlying tool error the model needs to read.
    if (error && !error.startsWith("otter: blocked repeated call")) entry.lastError = errorExcerpt(error)
  }

  /** Current count for a signature (for tests / diagnostics). */
  countOf(sessionID: string, tool: string, args: unknown): number {
    return this.sessions.get(sessionID)?.get(signatureOf(tool, args))?.count ?? 0
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID)
    this.calls.delete(sessionID)
  }

  private ring(sessionID: string): Map<string, Entry> {
    let ring = this.sessions.get(sessionID)
    if (!ring) {
      ring = new Map()
      this.sessions.set(sessionID, ring)
    }
    return ring
  }

  private callMap(sessionID: string): Map<string, string> {
    let m = this.calls.get(sessionID)
    if (!m) {
      m = new Map()
      this.calls.set(sessionID, m)
    }
    return m
  }
}

function trimMap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next().value as K
    m.delete(oldest)
  }
}
