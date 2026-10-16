import type { InteractiveViewFacts } from "../hosts/interactive-view.ts"
import { clipToWidth, displayWidth } from "./render.ts"

export type StatusInput = {
  readonly facts?: InteractiveViewFacts
  readonly workflow?: string
  readonly activity: string
  readonly search?: string
  readonly queued: number
  readonly columns: number
  readonly notice?: string
  readonly ascii?: boolean
  readonly selectionInHeader?: boolean
}

type Segment = { text: string; priority: number }

function factSegments(facts: InteractiveViewFacts | undefined, selectionInHeader: boolean): Segment[] {
  if (!facts) return []
  const safety: string[] = []
  if (facts.identity.mode === "retained-read-only") safety.push("read-only")
  if (facts.hold.state === "known" && facts.hold.value.held) safety.push("held")
  if (facts.owner === "foreign" || facts.owner === "unknown") safety.push(`owner:${facts.owner}`)
  if (facts.claim.state === "known" && facts.claim.value) safety.push("claim")
  if (facts.fence.state === "known" && facts.fence.value) safety.push("fence")
  if (facts.termination === "unconfirmed") safety.push("termination:?")
  if (facts.request.state === "failed") {
    const category = facts.request.category.state === "known" ? facts.request.category.value : "category unknown"
    const retry = facts.request.retryable.state === "known" ? facts.request.retryable.value ? "retryable" : "not retryable" : "retry unknown"
    safety.push(`request:failed(${category};${retry})`)
  }
  if (facts.request.state === "cancellation-unconfirmed") safety.push("request-cancel:?")
  const segments: Segment[] = safety.length ? [{ text: `safety[${safety.join(" ")}]`, priority: 200 }] : []
  if (!selectionInHeader) segments.push({ text: `${facts.selection.engine} / ${facts.selection.model}`, priority: 50 })
  if (facts.request.state === "in-progress") segments.push({ text: "Model request running", priority: 90 })
  if (facts.discovery === "failed") segments.push({ text: "Model list unavailable", priority: 85 })
  if (facts.hold.state === "known" && facts.hold.value.held && facts.hold.value.reason) {
    segments.push({ text: `hold reason: ${facts.hold.value.reason}`, priority: 55 })
  }
  return segments
}

function pack(segments: readonly Segment[], columns: number, separator: string): string[] {
  const ordered = [...segments].sort((left, right) => right.priority - left.priority)
  const rows: string[] = []
  let omitted = 0
  for (const segment of ordered) {
    let placed = false
    for (let index = 0; index < rows.length; index += 1) {
      const candidate = rows[index] ? `${rows[index]}${separator}${segment.text}` : segment.text
      if (displayWidth(candidate) <= columns) { rows[index] = candidate; placed = true; break }
    }
    if (!placed && rows.length < 2) {
      rows.push(clipToWidth(segment.text, columns))
      if (displayWidth(segment.text) > columns) omitted += 1
    } else if (!placed) omitted += 1
  }
  if (omitted && rows.length) {
    const index = rows.length - 1
    const indicator = clipToWidth(` | +${omitted} more`, columns)
    const remaining = Math.max(0, columns - displayWidth(indicator))
    rows[index] = (remaining ? clipToWidth(rows[index]!, remaining) : "") + indicator
  }
  return rows.filter(Boolean)
}

export function statusLines(input: StatusInput): string[] {
  const segments: Segment[] = [
    ...factSegments(input.facts, input.selectionInHeader === true),
    ...(input.search ? [{ text: `search: ${input.search}`, priority: 70 }] : []),
    ...(input.queued ? [{ text: `queued ${input.queued}`, priority: 75 }] : []),
    ...(input.workflow ? [{ text: input.workflow, priority: 80 }] : []),
    { text: input.activity, priority: 70 },
    ...(input.notice ? [{ text: input.notice, priority: 110 }] : []),
  ]
  return pack(segments, Math.max(1, Math.floor(input.columns)), input.ascii ? " | " : " · ")
}
