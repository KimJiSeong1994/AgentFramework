// Compact result rendering for the model: header + tab-separated rows, capped by rows / cell width / estimated tokens,
// with a closing hint line (row count, truncation, "columns you can omit next time") — the Sophrosyne-style hint from
// the design review that cut over-exploration.
import { estimateTokens } from "../tokens.ts"

export type QueryRows = { columns: string[]; rows: unknown[][] }

export function cell(v: unknown, max: number): string {
  let s: string
  if (v === null || v === undefined) s = "NULL"
  else if (typeof v === "object") s = JSON.stringify(v)
  else s = String(v)
  s = s.replace(/[\t\n\r]+/g, " ")
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

export function formatRows(res: QueryRows, opts: { maxRows: number; maxCell: number; maxTokens: number; elapsedMs?: number }): string {
  const total = res.rows.length
  const shown = res.rows.slice(0, opts.maxRows)
  const lines: string[] = [res.columns.join("\t")]
  for (const r of shown) lines.push(r.map((v) => cell(v, opts.maxCell)).join("\t"))
  let text = lines.join("\n")
  let cut = 0
  while (estimateTokens(text) > opts.maxTokens && lines.length > 2) {
    lines.pop()
    cut++
    text = lines.join("\n")
  }
  const visible = shown.length - cut
  const notes: string[] = [`${total === 0 ? "0 rows" : total > opts.maxRows ? `${opts.maxRows}+ rows (more exist)` : `${total} row${total === 1 ? "" : "s"}`}`]
  if (cut > 0) notes.push(`${cut} more rows hidden to fit the budget`)
  if (visible < total) notes.push("add a WHERE or an aggregate instead of asking for more rows")
  const wide = res.columns.filter((_, i) => shown.some((r) => cell(r[i], 10_000).length > opts.maxCell))
  if (wide.length) notes.push(`long columns truncated: ${wide.join(", ")}`)
  if (opts.elapsedMs !== undefined) notes.push(`${opts.elapsedMs} ms`)
  return `${text}\n-- ${notes.join("; ")}`
}
