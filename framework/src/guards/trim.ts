// Tool output trimming: tool results bloat the context (compaction cost 45% of a session in the review).
// read keeps the head only (the model can page with offset/limit); other tools keep head 70% + tail 30%.

export const TRIM_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "grep", "glob", "list", "webfetch", "evo-semantic_browse_semantics", "evo-semantic_resolve_semantics"])

import { estimateTokens } from "../tokens.ts"

export type TrimConfig = { read_max_lines: number; read_max_bytes: number; read_max_tokens?: number }

export type TrimResult = { output: string; trimmed: boolean; originalLines: number; originalBytes: number }

const HEAD_RATIO = 0.7

export function trimMarker(lines: number, bytes: number): string {
  return `[otter: trimmed ${lines} lines / ${bytes} bytes — re-read with offset/limit if needed]`
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

export function trimToolOutput(tool: string, output: string, cfg: TrimConfig): TrimResult {
  const originalBytes = byteLength(output)
  const lines = output.split("\n")
  const originalLines = lines.length
  const untouched: TrimResult = { output, trimmed: false, originalLines, originalBytes }
  if (!TRIM_TOOLS.has(tool)) return untouched

  const maxLines = Math.max(1, Math.floor(cfg.read_max_lines))
  // Token cap folded into the byte budget using this output's own bytes/token ratio (paths ≈ 2 chars/token,
  // prose ≈ 4), so a 19.9 KB glob listing that is really ~10K tokens still gets cut.
  let maxBytes = Math.max(1, Math.floor(cfg.read_max_bytes))
  const maxTokens = cfg.read_max_tokens && cfg.read_max_tokens > 0 ? Math.floor(cfg.read_max_tokens) : 0
  const originalTokens = maxTokens ? estimateTokens(output) : 0
  if (maxTokens && originalTokens > maxTokens) {
    const ratio = originalBytes / Math.max(1, originalTokens)
    maxBytes = Math.min(maxBytes, Math.max(1, Math.floor(maxTokens * ratio * 0.95)))
  }
  if (originalLines <= maxLines && originalBytes <= maxBytes) return untouched

  let head: string[]
  let tail: string[]
  if (tool === "read") {
    head = lines.slice(0, Math.min(maxLines, originalLines))
    tail = []
  } else if (originalLines > maxLines) {
    const headN = Math.max(1, Math.floor(maxLines * HEAD_RATIO))
    const tailN = Math.max(0, maxLines - headN)
    head = lines.slice(0, headN)
    tail = tailN > 0 ? lines.slice(originalLines - tailN) : []
  } else {
    head = lines
    tail = []
  }

  // Byte budget: shrink head (and tail, proportionally) until the kept text fits.
  let kept = joinKept(head, tail)
  if (byteLength(kept) > maxBytes) {
    const headBudget = tool === "read" || tail.length === 0 ? maxBytes : Math.floor(maxBytes * HEAD_RATIO)
    const tailBudget = maxBytes - headBudget
    head = takeBytesFromStart(head, headBudget)
    tail = tailBudget > 0 ? takeBytesFromEnd(tail, tailBudget) : []
    kept = joinKept(head, tail)
  }

  const keptLines = head.length + tail.length
  const keptBytes = byteLength(kept)
  const marker = trimMarker(Math.max(0, originalLines - keptLines), Math.max(0, originalBytes - keptBytes))
  const out = tail.length > 0 ? `${head.join("\n")}\n${marker}\n${tail.join("\n")}` : `${head.join("\n")}\n${marker}`
  return { output: out, trimmed: true, originalLines, originalBytes }
}

function joinKept(head: string[], tail: string[]): string {
  return tail.length ? `${head.join("\n")}\n${tail.join("\n")}` : head.join("\n")
}

function takeBytesFromStart(lines: string[], budget: number): string[] {
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const b = byteLength(line) + 1
    if (used + b > budget) {
      if (out.length === 0) out.push(cutBytes(line, budget))
      break
    }
    out.push(line)
    used += b
  }
  return out
}

function takeBytesFromEnd(lines: string[], budget: number): string[] {
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const b = byteLength(line) + 1
    if (used + b > budget) break
    out.unshift(line)
    used += b
  }
  return out
}

function cutBytes(line: string, budget: number): string {
  const buf = Buffer.from(line, "utf8")
  if (buf.length <= budget) return line
  return buf.subarray(0, Math.max(0, budget - 1)).toString("utf8").replace(/�+$/, "") + "…"
}
