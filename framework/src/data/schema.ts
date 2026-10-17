// Static schema description for `schema_lookup`: a JSON file the project ships (generated from the DDL by
// scripts/otter-schema-extract.py or written by hand). Never a live catalog dump — one table per call, ~500 est. tokens.
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { estimateTokens } from "../tokens.ts"

export type SchemaColumn = { name: string; type: string; description?: string; values?: string[] }
export type SchemaTable = {
  description?: string
  columns: SchemaColumn[]
  primary_key?: string[]
  foreign_keys?: string[]
  partitions?: string
  notes?: string[]
}
export type SchemaFile = {
  dialect: "sqlite" | "postgres"
  /** schema/prefix the model must use, e.g. "analytics." (empty for sqlite) */
  table_prefix?: string
  notes?: string[]
  tables: Record<string, SchemaTable>
}

export function resolvePath(worktree: string, p: string): string {
  return isAbsolute(p) ? p : join(worktree, p)
}

export function loadSchema(worktree: string, file: string): SchemaFile | null {
  const p = resolvePath(worktree, file)
  if (!existsSync(p)) return null
  const parsed = JSON.parse(readFileSync(p, "utf8")) as SchemaFile
  if (!parsed || typeof parsed !== "object" || !parsed.tables) throw new Error(`schema file ${p} has no "tables"`)
  return parsed
}

export function tableList(schema: SchemaFile): string {
  const lines = Object.entries(schema.tables).map(([name, t]) => `- ${name}: ${(t.description ?? "").slice(0, 90)} (${t.columns.length} columns)`)
  const head = [`dialect: ${schema.dialect}${schema.table_prefix ? `, prefix tables with "${schema.table_prefix}"` : ""}`, ...(schema.notes ?? []).map((n) => `note: ${n}`)]
  return [...head, "tables:", ...lines, "Call schema_lookup with one table name for its columns."].join("\n")
}

export function describeTable(schema: SchemaFile, name: string, maxTokens = 600): string {
  const key = Object.keys(schema.tables).find((k) => k === name || k.toLowerCase() === name.toLowerCase() || k.endsWith("." + name))
  if (!key) return `unknown table "${name}".\n${tableList(schema)}`
  const t = schema.tables[key]!
  const lines: string[] = [`${schema.table_prefix ?? ""}${key}: ${t.description ?? ""}`.trim()]
  if (t.primary_key?.length) lines.push(`primary key: ${t.primary_key.join(", ")}`)
  if (t.foreign_keys?.length) lines.push(`foreign keys: ${t.foreign_keys.join("; ")}`)
  if (t.partitions) lines.push(`partitions: ${t.partitions}`)
  lines.push("columns:")
  for (const c of t.columns) {
    const vals = c.values?.length ? ` values: ${c.values.join("|")}` : ""
    lines.push(`- ${c.name} ${c.type}${c.description ? ` — ${c.description}` : ""}${vals}`)
  }
  for (const n of t.notes ?? []) lines.push(`note: ${n}`)
  let text = lines.join("\n")
  while (estimateTokens(text) > maxTokens && lines.length > 3) {
    lines.splice(lines.length - 1, 1)
    text = lines.join("\n") + "\n… (truncated)"
  }
  return text
}
