import { displayWidth } from "./render.ts"

/** Terminal mouse coordinates are one-based. */
export type SelectionPoint = { x: number; y: number }

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

type SelectedRow = { y: number; x: number; text: string }

function selectedRows(rows: readonly string[], anchor: SelectionPoint, focus: SelectionPoint): SelectedRow[] {
  if (!rows.length) return []
  const clamp = (point: SelectionPoint): SelectionPoint => ({
    x: Math.max(1, Math.floor(point.x)),
    y: Math.max(1, Math.min(rows.length, Math.floor(point.y))),
  })
  let start = clamp(anchor)
  let end = clamp(focus)
  if (start.y > end.y || (start.y === end.y && start.x > end.x)) [start, end] = [end, start]
  const selected: SelectedRow[] = []
  for (let y = start.y; y <= end.y; y += 1) {
    const left = y === start.y ? start.x : 1
    const right = y === end.y ? end.x : Infinity
    let column = 1
    let x = left
    let text = ""
    for (const { segment } of graphemes.segment(rows[y - 1]!)) {
      const width = displayWidth(segment)
      // Selecting either cell of a wide grapheme selects that whole grapheme.
      if (column <= right && column + Math.max(1, width) - 1 >= left) {
        if (!text) x = column
        text += segment
      }
      column += width
    }
    selected.push({ y, x, text })
  }
  return selected
}

export function selectionText(rows: readonly string[], anchor: SelectionPoint, focus: SelectionPoint): string {
  return selectedRows(rows, anchor, focus).map(row => row.text.trimEnd()).join("\n")
}

/** Paint just the selected text over a cached frame; the caller restores the cursor. */
export function selectionOverlay(rows: readonly string[], anchor: SelectionPoint, focus: SelectionPoint): string {
  return selectedRows(rows, anchor, focus)
    .filter(row => row.text.length > 0)
    .map(row => `\x1b[${row.y};${row.x}H\x1b[7m${row.text}\x1b[0m`)
    .join("")
}
