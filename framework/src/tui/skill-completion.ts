import type { SkillCatalog, SkillCatalogEntry } from "../skills/session.ts"
import { commandInsertions } from "../hosts/interactive-actions.ts"

export type SkillCompletionRow = Readonly<{
  name: string
  description: string
  source: "builtin" | "project" | "home"
  classification: "common" | "custom" | "unavailable"
  refusal?: string
  insertion?: string
}>

export type SkillCompletion = Readonly<{ query: string; rows: readonly SkillCompletionRow[] }>

const protectedWorkflowNames = new Set(["deep-interview", "ralplan", "ultragoal", "autoresearch"])

function matches(query: string, ...values: Array<string | undefined>): boolean {
  const normalized = query.toLocaleLowerCase()
  return !normalized || values.some(value => value?.toLocaleLowerCase().includes(normalized))
}

function rowForEntry(entry: SkillCatalogEntry): SkillCompletionRow {
  const descriptor = entry.descriptor
  const protectedName = protectedWorkflowNames.has(descriptor.name)
  const builtinProtected = descriptor.kind === "protected-workflow" && descriptor.source === "builtin"
  const protectedRefusal = protectedName && !builtinProtected ? "protected-name (builtin only)" : undefined
  const refusal = entry.refusal ?? protectedRefusal
  const selectable = entry.classification !== "unavailable" && refusal === undefined && !protectedRefusal

  return {
    name: descriptor.name,
    description: descriptor.description,
    source: descriptor.source,
    classification: entry.classification,
    ...(refusal === undefined ? {} : { refusal }),
    ...(selectable ? { insertion: `/skill:${descriptor.name} ` } : {}),
  }
}

export function skillCompletion(catalog: SkillCatalog | undefined, draft: string): SkillCompletion | undefined {
  const prefix = /^\/skill:([^\s]*)$/u.exec(draft)
  if (!prefix) return undefined

  const query = prefix[1] ?? ""
  const rows: SkillCompletionRow[] = []
  for (const entry of catalog?.entries ?? []) {
    if (matches(query, entry.descriptor.name, entry.descriptor.description)) rows.push(rowForEntry(entry))
  }
  for (const refusal of catalog?.refusals ?? []) {
    if (!matches(query, refusal.name, refusal.reason, refusal.source)) continue
    rows.push({
      name: refusal.name ?? "(unnamed)",
      description: "",
      source: refusal.source,
      classification: "unavailable",
      refusal: refusal.reason,
    })
  }
  return { query, rows }
}

/** Returns text for the composer only; this helper never invokes or authorizes a skill. */
export function skillCompletionInsertion(row: SkillCompletionRow | undefined): string | undefined {
  return row?.insertion
}

export function formatSkillCompletionRow(row: SkillCompletionRow): [string, string] {
  const name = row.description ? `${row.name} — ${row.description}` : row.name
  const refusal = row.refusal === undefined ? "" : ` · Refusal: ${row.refusal}`
  return [name, `Source: ${row.source} · Classification: ${row.classification}${refusal}`]
}

/** A bounded window that always includes the currently selected row when rows are available. */
export function skillCompletionWindow(
  rows: readonly SkillCompletionRow[],
  selectedIndex: number,
  maximumRows: number,
): { start: number; rows: readonly SkillCompletionRow[] } {
  const count = Math.min(rows.length, Math.max(0, Number.isFinite(maximumRows) ? Math.floor(maximumRows) : 0))
  if (count === 0) return { start: 0, rows: [] }

  const selected = Math.max(0, Math.min(rows.length - 1, Number.isFinite(selectedIndex) ? Math.floor(selectedIndex) : 0))
  const start = Math.max(0, Math.min(rows.length - count, selected - Math.floor(count / 2)))
  return { start, rows: rows.slice(start, start + count) }
}

export function commandCompletions(draft: string): string[] {
  return commandInsertions(draft)
}
