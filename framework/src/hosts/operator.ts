import { createInterface } from "node:readline/promises"

export type OperatorDecision = LocalOperatorDecision

type DecisionFields = {
  action: "approve" | "reject"
  workflowID: string
  planSha: string
  reason?: string
}

class LocalOperatorDecision {
  #brand = true
  readonly action: DecisionFields["action"]
  readonly workflowID: string
  readonly planSha: string
  readonly reason?: string

  private constructor(fields: DecisionFields) {
    this.action = fields.action
    this.workflowID = fields.workflowID
    this.planSha = fields.planSha
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
  workflowID: string,
  planSha: string,
): Promise<OperatorDecision> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("local human approval or rejection requires an interactive terminal")
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const approve = `APPROVE ${workflowID} ${planSha}`
    const reject = `REJECT ${workflowID} ${planSha}`
    const answer = (await terminal.question(`Inspect the saved canonical plan first. Type '${approve}' or '${reject} <reason>': `)).trim()
    if (answer === approve && action !== "reject") return issue({ action: "approve", workflowID, planSha })
    if (answer.startsWith(`${reject} `) && answer.slice(reject.length).trim() && action !== "approve") {
      return issue({ action: "reject", workflowID, planSha, reason: answer.slice(reject.length).trim() })
    }
    throw new Error("local operator decision did not match workflow ID and plan hash")
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
