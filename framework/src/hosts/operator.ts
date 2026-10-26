import { createInterface } from "node:readline/promises"
import type { Subject } from "../workflows/types.ts"

export type OperatorDecision = LocalOperatorDecision

/** What an operator decision is about; the controller refuses a receipt whose binding is no longer current. */
export type DecisionBinding = {
  sessionID: string
  workflowID: string
  expectedRevision: number
  subject: Subject
}

type DecisionFields = DecisionBinding & {
  action: "approve" | "reject"
  reason?: string
}

class LocalOperatorDecision {
  #brand = true
  readonly action: DecisionFields["action"]
  readonly sessionID: string
  readonly workflowID: string
  readonly expectedRevision: number
  readonly subject: Readonly<Subject>
  readonly reason?: string

  private constructor(fields: DecisionFields) {
    this.action = fields.action
    this.sessionID = fields.sessionID
    this.workflowID = fields.workflowID
    this.expectedRevision = fields.expectedRevision
    this.subject = Object.freeze({ kind: fields.subject.kind, id: fields.subject.id, sha256: fields.subject.sha256 })
    if (fields.reason !== undefined) this.reason = fields.reason
    Object.freeze(this)
  }

  static issue(fields: DecisionFields): LocalOperatorDecision {
    return new LocalOperatorDecision(fields)
  }

  hasBrand(): boolean {
    return this.#brand
  }
}

const issued = new WeakMap<object, LocalOperatorDecision>()

function issue(fields: DecisionFields): OperatorDecision {
  const receipt = LocalOperatorDecision.issue(fields)
  issued.set(receipt, receipt)
  return receipt
}

/** Read explicit operator intent from the real process terminal; receipts cannot be built from caller data. */
export async function humanDecision(
  action: "approve" | "reject" | "choose",
  binding: DecisionBinding,
  signal?: AbortSignal,
): Promise<OperatorDecision> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("local human approval or rejection requires an interactive terminal")
  // Kernel cooked input owns editing here; readline terminal mode would turn
  // raw mode back on after the TUI's exclusive reader handoff.
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: false })
  try {
    const { workflowID } = binding
    // The typed string keeps its CLI shape: the hash is the subject hash (the canonical plan hash for a plan subject).
    const approve = `APPROVE ${workflowID} ${binding.subject.sha256}`
    const reject = `REJECT ${workflowID} ${binding.subject.sha256}`
    const subjectDescription = binding.subject.kind === "experiment-unit"
      ? "experiment scope, selected data, models, and budget"
      : binding.subject.kind === "implementation-unit"
        ? "exact implementation change and verification evidence"
        : "saved canonical plan"
    const answer = (await terminal.question(`Inspect the ${subjectDescription} first. Type '${approve}' or '${reject} <reason>': `, { signal })).trim()
    if (answer === approve && action !== "reject") return issue({ ...binding, action: "approve" })
    if (answer.startsWith(`${reject} `) && answer.slice(reject.length).trim() && action !== "approve") {
      return issue({ ...binding, action: "reject", reason: answer.slice(reject.length).trim() })
    }
    throw new Error("local operator decision did not match workflow ID and subject hash")
  } finally { terminal.close() }
}

/** Consume a genuine reader-issued receipt before any downstream validation, including checks that may fail. */
export function consumeOperatorDecision(value: unknown): OperatorDecision {
  if (typeof value !== "object" || value === null) throw new TypeError("local operator decision was not issued by the terminal reader")
  const receipt = issued.get(value)
  if (!receipt || !receipt.hasBrand()) throw new TypeError("local operator decision was not issued by the terminal reader")
  issued.delete(value)
  return receipt
}
