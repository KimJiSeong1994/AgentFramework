import { createHash } from "node:crypto"
import type {
  LinuxAdmissionHealth, VerificationCancelResult, VerificationExecutor, VerificationHandle, VerificationPreflight,
  VerificationProfile, VerificationReconciliation, VerificationReference, VerificationRequest, VerificationResult,
} from "./verifier.ts"
import {
  authenticateLinuxVerification, inspectLinuxVerifierProfile, isCurrentLinuxVerifierReference, runLinuxVerifierClient,
} from "../hosts/linux-domain.ts"

const UNKNOWN_RECONCILIATION: VerificationReconciliation = {
  outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown",
}
const CONTROL_CALL_MS = 90_000
const PREFLIGHT_CALL_MS = 30_000
const POLL_MS = 100
const RETIREMENT_GRACE_MS = 45_000
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
const UNIT = "lca-verifier.service"

function unknownResult(): VerificationResult {
  return {
    profile: "linux-single-use", parentExit: null, timedOut: false, cancelled: false,
    isolationEstablished: false, domainState: "unknown", integrity: "unknown", output: "",
  }
}

function validRequest(request: VerificationRequest): Uint8Array {
  if (request.profile !== "linux-single-use" || !request.executionID || request.executionID.includes("\0") ||
    typeof request.command !== "string" || request.command.includes("\0") || request.command.length > 262_144 ||
    typeof request.cwd !== "string" || request.cwd.includes("\0") || request.cwd.length > 4096 ||
    !TREE_ID.test(request.inputSnapshotID) || !SHA256.test(request.inputDigest) ||
    createHash("sha256").update(request.inputSnapshotID, "utf8").digest("hex") !== request.inputDigest ||
    !Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= Date.now() ||
    !Number.isSafeInteger(request.maxOutputChars) || request.maxOutputChars < 1 || request.maxOutputChars > 65_536) {
    throw new TypeError("invalid Linux verifier request")
  }
  const archive = request.inputArchive
  if (!(archive instanceof Uint8Array) || archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new TypeError("Linux verifier requires a bounded immutable input archive")
  }
  return archive
}

function validReference(value: unknown): value is VerificationReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const reference = value as Record<string, unknown>
  const keys = Object.keys(reference).sort()
  const expected = ["kind", "executionID", "profile", "invocationID", "inputSnapshotID", "inputDigest", "deadlineAt", "maxOutputChars", "unit", "bootID"].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false
  return reference.kind === "verifier" && typeof reference.executionID === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(reference.executionID) &&
    reference.profile === "linux-single-use" && typeof reference.invocationID === "string" && /^[0-9a-f]{32}$/.test(reference.invocationID) &&
    typeof reference.inputSnapshotID === "string" && TREE_ID.test(reference.inputSnapshotID) &&
    typeof reference.inputDigest === "string" && SHA256.test(reference.inputDigest) &&
    createHash("sha256").update(reference.inputSnapshotID, "utf8").digest("hex") === reference.inputDigest &&
    Number.isSafeInteger(reference.deadlineAt) && (reference.deadlineAt as number) > 0 &&
    Number.isSafeInteger(reference.maxOutputChars) && (reference.maxOutputChars as number) > 0 &&
    (reference.maxOutputChars as number) <= 65_536 && reference.unit === UNIT &&
    typeof reference.bootID === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference.bootID)
}

function responseState(response: Record<string, unknown>): "running" | "terminal" | "unknown" {
  return response.state === "running" || response.state === "terminal" ? response.state : "unknown"
}

function authenticatedResult(response: Record<string, unknown>, reference: VerificationReference): VerificationResult | undefined {
  if (responseState(response) !== "terminal" || !response.result || typeof response.result !== "object" || Array.isArray(response.result)) return undefined
  const result = response.result as VerificationResult
  return authenticateLinuxVerification(result, reference) ? result : undefined
}

function reconciliationFromResponse(response: Record<string, unknown>, reference: VerificationReference): VerificationReconciliation {
  const state = responseState(response)
  if (state === "terminal") {
    const result = authenticatedResult(response, reference)
    if (result) return {
      outcome: "terminal", isolationEstablished: true, domainState: "empty", integrity: result.integrity, result,
    }
    return UNKNOWN_RECONCILIATION
  }
  if (state === "running") return {
    outcome: "running", isolationEstablished: false, domainState: "active", integrity: "unknown",
  }
  return UNKNOWN_RECONCILIATION
}

function controlDeadline(): number { return Date.now() + CONTROL_CALL_MS }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function referenceFromResponse(value: unknown, request: VerificationRequest): VerificationReference {
  if (!validReference(value)) throw new TypeError("gate returned an invalid Linux verifier reference")
  const reference = value
  if (reference.executionID !== request.executionID || reference.profile !== request.profile ||
    reference.inputSnapshotID !== request.inputSnapshotID || reference.inputDigest !== request.inputDigest ||
    reference.deadlineAt !== request.deadlineAt || reference.maxOutputChars !== request.maxOutputChars ||
    reference.unit !== UNIT || !isCurrentLinuxVerifierReference(reference)) {
    throw new Error("gate returned a reference that does not bind the current request and boot")
  }
  return reference
}

function gateFailure(response: Record<string, unknown>): Error {
  return new Error(typeof response.error === "string" ? response.error.slice(0, 1024) : "Linux verifier gate refused the request")
}

const ADMISSION_REASONS = new Set<LinuxAdmissionHealth["reasons"][number]>([
  "boot-epoch", "unknown-bound", "stale-active", "latched", "journal-persistence", "journal-entry", "journal-readable",
])

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseAdmissionHealth(value: unknown): LinuxAdmissionHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const health = value as Record<string, unknown>
  if (!exactKeys(health, [
    "bootEpochMatch", "journal", "pendingTickets", "pendingBytes", "unknownBound", "staleActive",
    "latched", "quarantineRequired", "capacityAvailable", "reasons",
  ]) || typeof health.bootEpochMatch !== "boolean" || typeof health.latched !== "boolean" ||
    typeof health.quarantineRequired !== "boolean" || typeof health.capacityAvailable !== "boolean" ||
    !nonnegativeSafeInteger(health.pendingTickets) || !nonnegativeSafeInteger(health.pendingBytes) ||
    !nonnegativeSafeInteger(health.unknownBound) || !nonnegativeSafeInteger(health.staleActive) ||
    !health.journal || typeof health.journal !== "object" || Array.isArray(health.journal) || !Array.isArray(health.reasons)) {
    return undefined
  }
  const journal = health.journal as Record<string, unknown>
  if (!exactKeys(journal, ["persistentEffective", "persistentEntry", "readable"]) ||
    typeof journal.persistentEffective !== "boolean" || typeof journal.persistentEntry !== "boolean" ||
    typeof journal.readable !== "boolean" || health.reasons.length > ADMISSION_REASONS.size ||
    health.reasons.some(reason => typeof reason !== "string" || !ADMISSION_REASONS.has(reason as LinuxAdmissionHealth["reasons"][number])) ||
    new Set(health.reasons).size !== health.reasons.length) return undefined
  return health as LinuxAdmissionHealth
}

function parsePreflightResponse(response: Record<string, unknown>): {
  compatible: boolean
  problems: string[]
  admission: LinuxAdmissionHealth
} | undefined {
  if (!exactKeys(response, ["ok", "compatible", "problems", "admission"]) || response.ok !== true ||
    typeof response.compatible !== "boolean" || !Array.isArray(response.problems) || response.problems.length > 64 ||
    response.problems.some(problem => typeof problem !== "string" || problem.length > 1024 || problem.includes("\0"))) {
    return undefined
  }
  const admission = parseAdmissionHealth(response.admission)
  if (!admission) return undefined
  return { compatible: response.compatible, problems: response.problems as string[], admission }
}

function admissionCompatible(admission: LinuxAdmissionHealth): boolean {
  return admission.bootEpochMatch && admission.journal.persistentEffective && admission.journal.persistentEntry &&
    admission.journal.readable && !admission.latched && !admission.quarantineRequired
}

export function createLinuxVerifierExecutor(options: { qualification?: boolean } = {}): VerificationExecutor {
  if (options === null || typeof options !== "object" ||
    Object.keys(options).some(key => key !== "qualification") ||
    options.qualification !== undefined && typeof options.qualification !== "boolean") {
    throw new TypeError("invalid Linux verifier executor options")
  }
  const qualification = options.qualification ?? false

  return {
    async preflight(profile: VerificationProfile): Promise<VerificationPreflight> {
      if (profile !== "linux-single-use") return { compatible: false, problems: [`unsupported verifier profile: ${profile}`] }
      const local = inspectLinuxVerifierProfile(qualification)
      try {
        // Qualification bypass is diagnostic-only: it lets the fixed trusted profile query health,
        // but execution paths continue to use the executor's production qualification setting.
        const response = await runLinuxVerifierClient("preflight", undefined, Date.now() + PREFLIGHT_CALL_MS, true)
        const parsed = parsePreflightResponse(response)
        if (!parsed) return {
          compatible: false,
          problems: [...local.problems, "Linux verifier gate returned an invalid preflight health response"],
        }
        const problems = [...local.problems, ...parsed.problems]
        if (parsed.admission.reasons.length) {
          problems.push(`Linux admission health reasons: ${parsed.admission.reasons.join(",")}`)
        }
        return {
          compatible: local.compatible && parsed.compatible && admissionCompatible(parsed.admission),
          problems,
          admission: parsed.admission,
        }
      } catch (error) {
        return {
          compatible: false,
          problems: [...local.problems, error instanceof Error ? error.message : "Linux verifier gate is unavailable"],
        }
      }
    },

    async prepare(request: VerificationRequest): Promise<VerificationHandle> {
      const archive = validRequest(request)
      const local = inspectLinuxVerifierProfile(qualification)
      if (!local.compatible) throw new Error(local.problems.join("; ") || "Linux verifier authority is unavailable")
      const response = await runLinuxVerifierClient("prepare", {
        request: {
          executionID: request.executionID,
          profile: "linux-single-use",
          command: request.command,
          cwd: request.cwd,
          inputSnapshotID: request.inputSnapshotID,
          inputDigest: request.inputDigest,
          deadlineAt: request.deadlineAt,
          maxOutputChars: request.maxOutputChars,
          inputArchive: Buffer.from(archive).toString("base64"),
        },
      }, Math.min(request.deadlineAt, controlDeadline()), qualification)
      if (!response.reference) throw gateFailure(response)
      const reference = referenceFromResponse(response.reference, request)
      let cancelledBeforeRun = false
      let started = false
      let runPromise: Promise<VerificationResult> | undefined
      let terminalResult: VerificationResult | undefined
      const retirementDeadline = reference.deadlineAt + RETIREMENT_GRACE_MS

      const inspect = async (latestDeadlineAt: number): Promise<VerificationReconciliation> => {
        const observed = await runLinuxVerifierClient("inspect", { reference }, Math.min(latestDeadlineAt, controlDeadline()), qualification)
        return reconciliationFromResponse(observed, reference)
      }

      const runOnce = async (): Promise<VerificationResult> => {
        if (cancelledBeforeRun) throw new Error("Linux verifier cancelled before start")
        if (Date.now() >= reference.deadlineAt) return unknownResult()
        started = true
        try {
          const response = await runLinuxVerifierClient("start", { reference },
            Math.min(reference.deadlineAt, controlDeadline()), qualification)
          if (responseState(response) === "terminal") {
            const result = authenticatedResult(response, reference)
            if (result) return result
            return unknownResult()
          }
          // An unknown reply permits inspection of this ticket, never another start.
        } catch {
          // A lost start response is never retried: inspection may observe the original one-shot ticket only.
          if (Date.now() < reference.deadlineAt) {
            try {
              const recovered = await inspect(reference.deadlineAt)
              if (recovered.result) return recovered.result
            } catch {
              if (Date.now() < reference.deadlineAt) return unknownResult()
            }
          }
        }

        let cancelSent = false
        for (;;) {
          const now = Date.now()
          if (now >= reference.deadlineAt && !cancelSent) {
            cancelSent = true
            if (now >= retirementDeadline) return unknownResult()
            try {
              const cancelled = await runLinuxVerifierClient("cancel", { reference }, retirementDeadline, qualification)
              const result = authenticatedResult(cancelled, reference)
              if (result) return result
            } catch { /* Cancellation acknowledgement is not retirement; inspect the original ticket. */ }
          }
          if (now >= retirementDeadline) return unknownResult()
          try {
            const observed = await inspect(cancelSent ? retirementDeadline : reference.deadlineAt)
            if (observed.result) return observed.result
            // An empty domain may still be awaiting its signed journal-bound receipt.
            // Read-only polling neither retries start nor promotes uncertainty to retirement.
          } catch {
            if (!cancelSent && Date.now() >= reference.deadlineAt) continue
            return unknownResult()
          }
          await delay(POLL_MS)
        }
      }

      const handle: VerificationHandle = {
        reference,
        run() {
          if (!runPromise) {
            runPromise = runOnce().then(result => {
              if (authenticateLinuxVerification(result, reference)) terminalResult = result
              return result
            })
          }
          return runPromise
        },
        async requestCancel(_reason: string, deadlineAt: number): Promise<VerificationCancelResult> {
          if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) return { requested: false, acknowledged: false }
          if (terminalResult) return { requested: false, acknowledged: false, outcome: terminalResult }
          if (!started) {
            cancelledBeforeRun = true
            try {
              await runLinuxVerifierClient("cancel", { reference }, deadlineAt, qualification)
              // The gate acknowledges retiring this exact prepared ticket but supplies no workload proof.
              return { requested: true, acknowledged: true }
            } catch { return { requested: true, acknowledged: false } }
          }
          try {
            const response = await runLinuxVerifierClient("cancel", { reference }, deadlineAt, qualification)
            const result = authenticatedResult(response, reference)
            if (result) terminalResult = result
            const state = responseState(response)
            return {
              requested: true,
              acknowledged: state === "running" || state === "terminal",
              ...(result ? { outcome: result } : {}),
            }
          } catch { return { requested: true, acknowledged: false } }
        },
        async reconcile(): Promise<VerificationReconciliation> {
          // Read-only recovery remains valid after the execution deadline.
          try { return await inspect(Date.now() + 2000) } catch { return UNKNOWN_RECONCILIATION }
        },
      }
      return handle
    },

    async reconcile(reference: VerificationReference): Promise<VerificationReconciliation> {
      if (!validReference(reference)) throw new TypeError("invalid Linux verifier reference")
      try {
        const response = await runLinuxVerifierClient("inspect", { reference },
          Date.now() + 2000, qualification)
        return reconciliationFromResponse(response, reference)
      } catch { return UNKNOWN_RECONCILIATION }
    },
  }
}
