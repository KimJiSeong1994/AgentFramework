export type VerificationProfile = "legacy-unowned" | "linux-single-use"

export type VerificationRequest = {
  executionID: string
  supervisorSessionID: string
  taskID: string
  attemptID: string
  generation: number
  command: string
  cwd: string
  inputSnapshotID: string
  inputDigest: string
  /** Exact private Git-tree archive for an owned Linux verifier; never a live cwd copy. */
  inputArchive?: Uint8Array
  deadlineAt: number
  maxOutputChars: number
  env: Record<string, string>
  profile: VerificationProfile
  /** Persist the boundary reference before invoking run(). */
  onReference?: (reference: VerificationReference) => void
}

export type VerificationReference = {
  kind: "verifier"
  executionID: string
  profile: VerificationProfile
  /** Backend-owned single-use ticket; never a host session or systemd InvocationID. */
  invocationID: string
  inputSnapshotID: string
  inputDigest: string
  deadlineAt: number
  maxOutputChars: number
  unit?: string
  bootID?: string
}

export type VerificationProof = {
  reference: VerificationReference
  evidence: string
  /** Exact UTF-8 receipt and Ed25519 signature issued by the authenticated root gate. */
  receipt?: string
  signature?: string
}

export type VerificationResult = {
  profile: VerificationProfile
  parentExit: number | null
  timedOut: boolean
  cancelled: boolean
  isolationEstablished: boolean
  domainState: "active" | "empty" | "unknown"
  integrity: "unchanged" | "changed" | "unknown"
  output: string
  proof?: VerificationProof
}

export type VerificationReconciliation = {
  outcome: "running" | "terminal" | "unknown"
  isolationEstablished: boolean
  domainState: "active" | "empty" | "unknown"
  integrity: "unchanged" | "changed" | "unknown"
  proof?: VerificationProof
  /** Authenticated terminal result; booleans alone never authorize retirement. */
  result?: VerificationResult
}

export type VerificationCancelResult = { requested: boolean; acknowledged: boolean; outcome?: VerificationResult }
export type VerificationPreflight = { compatible: boolean; problems: string[] }

export interface VerificationHandle {
  readonly reference: VerificationReference
  run(): Promise<VerificationResult>
  requestCancel(reason: string, deadlineAt: number): Promise<VerificationCancelResult>
  reconcile(): Promise<VerificationReconciliation>
}

export interface VerificationExecutor {
  preflight(profile: VerificationProfile): Promise<VerificationPreflight>
  /** Inert: no workload or workload unit may start before durable intent and reference. */
  prepare(request: VerificationRequest): Promise<VerificationHandle>
  /** Reconcile a durable boundary reference without relaunching the command. */
  reconcile(reference: VerificationReference): Promise<VerificationReconciliation>
}
