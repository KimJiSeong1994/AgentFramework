import type { SkillCatalog, SkillCatalogEntry } from "../skills/session.ts"
import { commandInsertion, commandInsertions, interactiveActions, type InteractiveContext } from "../hosts/interactive-actions.ts"

/** One `/` palette row: a local command or a discovered skill. Selecting it only edits the composer. */
export type PaletteRow = Readonly<{
  kind: "command" | "skill"
  /** Shown name: `/model` for a command, `skill:deep-interview` for a skill. */
  label: string
  /** Bare match key: `model`, `deep-interview`. */
  name: string
  description: string
  source?: "builtin" | "project" | "home"
  refusal?: string
  /** Composer text; absent when the row is shown but cannot be selected. */
  insertion?: string
}>

export type Palette = Readonly<{ query: string; skillsOnly: boolean; rows: readonly PaletteRow[] }>

const protectedWorkflowNames = new Set(["deep-interview", "ralplan", "ultragoal", "autoresearch"])
/** Shown instead of skills before a model is chosen: no skill session (or catalog) exists yet. Not insertable. */
const UNSELECTED_SKILLS: PaletteRow = Object.freeze({
  kind: "command", label: "skill:…", name: "skill",
  description: "choose a model with /model first; skills are listed once a session starts",
})
const LABEL_COLUMNS = 26

function skillRow(entry: SkillCatalogEntry): PaletteRow {
  const descriptor = entry.descriptor
  const builtinProtected = descriptor.kind === "protected-workflow" && descriptor.source === "builtin"
  const protectedRefusal = protectedWorkflowNames.has(descriptor.name) && !builtinProtected ? "protected-name (builtin only)" : undefined
  const refusal = entry.refusal ?? protectedRefusal
  const selectable = entry.classification !== "unavailable" && refusal === undefined
  return {
    kind: "skill",
    label: `skill:${descriptor.name}`,
    name: descriptor.name,
    description: refusal === undefined ? descriptor.description : `unavailable · ${refusal}`,
    source: descriptor.source,
    ...(refusal === undefined ? {} : { refusal }),
    ...(selectable ? { insertion: `/skill:${descriptor.name} ` } : {}),
  }
}

function skillRows(catalog: SkillCatalog | undefined): PaletteRow[] {
  // A Codex/Claude copy of a builtin workflow is refused by name; the builtin row already covers it.
  const builtin = new Set((catalog?.entries ?? [])
    .filter(entry => entry.descriptor.kind === "protected-workflow" && entry.descriptor.source === "builtin")
    .map(entry => entry.descriptor.name))
  return [
    ...(catalog?.entries ?? []).map(skillRow),
    ...(catalog?.refusals ?? []).filter(refusal => !(refusal.reason === "protected-name" && refusal.name && builtin.has(refusal.name))).map(refusal => ({
      kind: "skill" as const,
      label: `skill:${refusal.name ?? "(unnamed)"}`,
      name: refusal.name ?? "(unnamed)",
      description: `unavailable · ${refusal.reason}`,
      source: refusal.source,
      refusal: refusal.reason,
    })),
  ]
}

function commandRows(context: InteractiveContext): PaletteRow[] {
  const seen = new Set<string>()
  return interactiveActions(context).flatMap(action => {
    const command = commandInsertion(action)
    if (!command?.startsWith("/") || seen.has(command)) return []
    seen.add(command)
    return [{ kind: "command" as const, label: command, name: command.slice(1), description: action.summary, insertion: `${command} ` }]
  })
}

/** Optimal string alignment distance; small inputs only (palette names). */
function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index, ...Array<number>(right.length).fill(0)])
  for (let column = 1; column <= right.length; column += 1) rows[0]![column] = column
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1)
      rows[i]![j] = best
    }
  }
  return rows[left.length]![right.length]!
}

/** Lower is better; undefined is no match. Prefix, then substring, then in-order letters, then one typo. */
export function fuzzyScore(query: string, name: string): number | undefined {
  const needle = query.toLocaleLowerCase()
  const haystack = name.toLocaleLowerCase()
  if (!needle) return 0
  if (haystack.startsWith(needle)) return 0
  const at = haystack.indexOf(needle)
  if (at >= 0) return 10 + at
  let position = -1
  let first = -1
  for (const character of needle) {
    position = haystack.indexOf(character, position + 1)
    if (position < 0) break
    if (first < 0) first = position
  }
  if (position >= 0) return 100 + (position - first)
  if (needle.length >= 3 && editDistance(needle, haystack.slice(0, needle.length)) <= 1) return 200
  return undefined
}

/**
 * The `/` palette: commands and skills in one list, fuzzy-matched by name (GJC style).
 * `/skill:` narrows to skills and also matches descriptions. Skills appear only where they can be invoked.
 */
export function palette(catalog: SkillCatalog | undefined, draft: string, context: InteractiveContext = "chat"): Palette | undefined {
  const skillsAllowed = interactiveActions(context).some(action => action.id === "skill")
  const scoped = /^\/skill:([^\s]*)$/u.exec(draft)
  if (scoped) {
    if (!skillsAllowed) return context === "unselected" ? { query: scoped[1] ?? "", skillsOnly: true, rows: [UNSELECTED_SKILLS] } : undefined
    const query = (scoped[1] ?? "").toLocaleLowerCase()
    const rows = skillRows(catalog).filter(row => !query || row.name.toLocaleLowerCase().includes(query) ||
      row.description.toLocaleLowerCase().includes(query) || (row.refusal !== undefined && row.source?.includes(query)))
    return { query, skillsOnly: true, rows }
  }
  const general = /^\/([a-z0-9:_-]*)$/iu.exec(draft)
  if (!general) return undefined
  const query = general[1] ?? ""
  const candidates = [...commandRows(context), ...(skillsAllowed ? skillRows(catalog) : [])]
  const ranked = candidates.flatMap((row, order) => {
    // A skill also matches by its shown label (prefix/substring only), so `/skill` lists every `skill:<name>`.
    const byName = fuzzyScore(query, row.name)
    const labelScore = row.kind === "skill" && query.length >= 2 ? fuzzyScore(query, row.label) : undefined
    const byLabel = labelScore !== undefined && labelScore < 100 ? labelScore : undefined
    const score = byName === undefined ? byLabel : byLabel === undefined ? byName : Math.min(byName, byLabel)
    return score === undefined ? [] : [{ row, score, order }]
  }).sort((left, right) => left.score - right.score || left.order - right.order)
  // Before a model is chosen no skill can run; say so instead of looking like no skills exist.
  if (!skillsAllowed && context === "unselected" && query.length >= 2 && (fuzzyScore(query, "skill:") ?? 100) < 100) {
    ranked.push({ row: UNSELECTED_SKILLS, score: 1, order: -1 })
    ranked.sort((left, right) => left.score - right.score || left.order - right.order)
  }
  if (!ranked.length) return undefined
  return { query, skillsOnly: false, rows: ranked.map(item => item.row) }
}

/** Returns text for the composer only; this helper never invokes or authorizes a skill. */
export function paletteInsertion(row: PaletteRow | undefined): string | undefined {
  return row?.insertion
}

/** `label  description` with a shared label column; the renderer mutes everything after the gap. */
export function formatPaletteRow(row: PaletteRow, labelColumns = LABEL_COLUMNS): string {
  const label = row.label.length > labelColumns ? `${row.label.slice(0, labelColumns - 1)}…` : row.label
  return row.description ? `${label.padEnd(labelColumns)}  ${row.description}` : label
}

export function paletteLabelColumns(rows: readonly PaletteRow[]): number {
  return Math.min(LABEL_COLUMNS, Math.max(8, ...rows.map(row => row.label.length)))
}

/** A bounded window that always includes the currently selected row when rows are available. */
export function paletteWindow(
  rows: readonly PaletteRow[],
  selectedIndex: number,
  maximumRows: number,
): { start: number; rows: readonly PaletteRow[] } {
  const count = Math.min(rows.length, Math.max(0, Number.isFinite(maximumRows) ? Math.floor(maximumRows) : 0))
  if (count === 0) return { start: 0, rows: [] }
  const selected = Math.max(0, Math.min(rows.length - 1, Number.isFinite(selectedIndex) ? Math.floor(selectedIndex) : 0))
  const start = Math.max(0, Math.min(rows.length - count, selected - Math.floor(count / 2)))
  return { start, rows: rows.slice(start, start + count) }
}

export function commandCompletions(draft: string): string[] {
  return commandInsertions(draft)
}
