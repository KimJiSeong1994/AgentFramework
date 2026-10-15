export type ViewIdentity =
  | { readonly mode: "writable"; readonly sessionID: string; readonly epoch: string }
  | { readonly mode: "retained-read-only"; readonly sessionID: string }

export type Known<T> =
  | { readonly state: "known"; readonly value: T }
  | { readonly state: "unknown" }

export type RequestObservation =
  | { readonly state: "not-observed" }
  | { readonly state: "in-progress"; readonly operationID: string }
  | { readonly state: "completed"; readonly operationID: string }
  | { readonly state: "failed"; readonly operationID: string; readonly category: Known<string>; readonly retryable: Known<boolean> }
  | { readonly state: "cancellation-unconfirmed"; readonly operationID: string }

export type WorkflowView = {
  readonly id: string
  readonly kind: string
  readonly stage: string
  readonly phase: string
  readonly revision: number
}

export type InteractiveViewFacts = {
  readonly identity: ViewIdentity
  readonly selection: { readonly engine: string; readonly model: string }
  readonly hold: Known<{ readonly held: boolean; readonly reason?: string }>
  readonly workflow: Known<WorkflowView | null>
  readonly owner: "current-session" | "foreign" | "none" | "unknown"
  readonly claim: Known<boolean>
  readonly fence: Known<boolean>
  readonly termination: "not-observed" | "proven" | "unconfirmed"
  readonly discovery: "not-observed" | "completed" | "failed"
  readonly request: RequestObservation
}

export type ApprovalBinding = {
  readonly sessionID: string
  readonly workflowID: string
  readonly expectedRevision: number
  readonly planSha: string
  readonly path: string
}

export type ChoicePresentation =
  | { readonly kind: "plain" }
  | { readonly kind: "approval"; readonly document: string; readonly binding: ApprovalBinding }
  | { readonly kind: "generic-list"; readonly rows: readonly string[]; readonly initialIndex?: number; readonly origin: ViewIdentity }

export type SessionCandidate = {
  readonly sessionID: string
  readonly engine: string
  readonly model?: string
  readonly current: boolean
  readonly state: "retained" | "held" | "read-only" | "corrupt" | "unknown"
  readonly detail?: string
}

export type TranscriptText = {
  readonly provenance: "user" | "assistant" | "notice" | "error" | "canonical-plan"
  readonly text: string
}

export function sameViewIdentity(left: ViewIdentity | undefined, right: ViewIdentity): boolean {
  if (!left || left.mode !== right.mode || left.sessionID !== right.sessionID) return false
  return left.mode === "retained-read-only" || right.mode === "retained-read-only" || left.epoch === right.epoch
}
