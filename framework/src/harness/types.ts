// Shared same-task probe contract (S1). Consumed by the lessons ledger (S3), which reads recorded runs only.
// A probe record states what a deterministic verify command did in an isolated worktree; it is not proof that an
// overlay caused the outcome.

/** "base1".."baseK" | "inv" | "dom" */
export type ProbeLabel = string

export type ProbeRun = {
  schema: "otter.probe-run.v1"
  probeWid: string
  label: ProbeLabel
  overlay: "none" | "inv" | "dom"
  overlaySha: string | null
  policyIDs: Record<string, string>
  baseTree: string
  resultTree: string | null
  verify: { ok: boolean; exitCode: number | null; timedOut: boolean; outputTail: string } | null
  diffStat: string
  durationMs: number
  valid: boolean
  invalid?: "unsettled" | "refused" | "integrity" | "interrupted"
}
