import { randomUUID } from "node:crypto"
import { startShell, type RunHandle } from "./shell.ts"
import type {
  VerificationCancelResult, VerificationExecutor, VerificationHandle, VerificationReconciliation,
  VerificationReference, VerificationRequest, VerificationResult,
} from "./verifier.ts"

const unknown = (): VerificationReconciliation => ({
  outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown",
})

function validReference(reference: VerificationReference): boolean {
  return reference?.kind === "verifier" && reference.profile === "legacy-unowned"
    && typeof reference.executionID === "string" && reference.executionID.length > 0
    && typeof reference.invocationID === "string" && reference.invocationID.length > 0
    && typeof reference.inputSnapshotID === "string" && reference.inputSnapshotID.length > 0
    && typeof reference.inputDigest === "string" && reference.inputDigest.length > 0
    && Number.isFinite(reference.deadlineAt)
    && Number.isSafeInteger(reference.maxOutputChars) && reference.maxOutputChars > 0
    && reference.unit === undefined && reference.bootID === undefined && !("cgroupInode" in reference)
}

/** Parent-shell execution only: a process-group signal cannot prove descendant quiescence. */
export function createLegacyVerifierExecutor(): VerificationExecutor {
  return {
    async preflight(profile) {
      return profile === "legacy-unowned"
        ? { compatible: true, problems: [] }
        : { compatible: false, problems: [`unsupported verifier profile: ${profile}`] }
    },
    async prepare(request: VerificationRequest): Promise<VerificationHandle> {
      if (request.profile !== "legacy-unowned") throw new Error(`unsupported verifier profile: ${request.profile}`)
      const reference: VerificationReference = Object.freeze({
        kind: "verifier", executionID: request.executionID, profile: "legacy-unowned",
        invocationID: randomUUID(), inputSnapshotID: request.inputSnapshotID,
        inputDigest: request.inputDigest, deadlineAt: request.deadlineAt,
        maxOutputChars: request.maxOutputChars,
      })
      if (!validReference(reference)) throw new TypeError("invalid legacy verifier reference")
      const command = request.command
      const cwd = request.cwd
      const env = { ...request.env }
      let shell: RunHandle | undefined
      let result: Promise<VerificationResult> | undefined
      let cancelledBeforeRun = false
      let finished = false
      return {
        reference,
        run() {
          if (cancelledBeforeRun) throw new Error("verifier cancelled before launch")
          if (result) return result
          const timeoutMs = reference.deadlineAt - Date.now()
          if (timeoutMs <= 0) throw new Error("verifier deadline expired before launch")
          shell = startShell(command, { cwd, timeoutMs, maxOutputChars: reference.maxOutputChars, env, replaceEnv: true })
          result = shell.result.then((outcome): VerificationResult => {
            finished = true
            return {
              profile: "legacy-unowned", parentExit: outcome.exitCode,
              timedOut: outcome.timedOut,
              cancelled: outcome.killed || (outcome.signal !== null && !outcome.timedOut),
              isolationEstablished: false, domainState: "unknown", integrity: "unknown",
              output: outcome.output,
            }
          })
          return result
        },
        async requestCancel(_reason: string, _deadlineAt: number): Promise<VerificationCancelResult> {
          if (finished) return { requested: false, acknowledged: false }
          if (!shell) {
            cancelledBeforeRun = true
          } else {
            shell.kill()
          }
          // A kill request, including a process-group signal, is not a family acknowledgement.
          return { requested: true, acknowledged: false }
        },
        async reconcile() { return unknown() },
      }
    },
    async reconcile(reference) {
      if (!validReference(reference)) throw new TypeError("invalid legacy verifier reference")
      // No shell may be replayed from a persisted ref; the parent and its descendants are unobservable here.
      return unknown()
    },
  }
}
