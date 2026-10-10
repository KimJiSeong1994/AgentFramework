import { EXECUTION_ROLES, type ExecutionHost, type ExecutionRole } from "./types.ts"

const COMMON_REQUIRED_CONTROLS = [
  "boundedInput",
  "boundedOutput",
  "preExecutionToolPolicy",
  "headlessPermissionRefusal",
  "ownedCancellation",
  "quiescenceEvidence",
  "identityBinding",
  "noReplayRecovery",
] as const

const MAIN_REVIEWER_CONTROLS = ["readOnlyWorktree"] as const
const WORKER_CONTROLS = ["serialWorkerLease"] as const

const ADMISSION_REFUSAL_MESSAGES = {
  requiredControls: "required control statuses unavailable",
  hostIncompatible: "host incompatible: required control statuses unavailable",
} as const

export class AdmissionRefusal extends Error {
  private constructor(message: keyof typeof ADMISSION_REFUSAL_MESSAGES) {
    super(ADMISSION_REFUSAL_MESSAGES[message])
    this.name = "AdmissionRefusal"
  }

  static requiredControlsUnavailable(): AdmissionRefusal {
    return new AdmissionRefusal("requiredControls")
  }

  static hostIncompatible(): AdmissionRefusal {
    return new AdmissionRefusal("hostIncompatible")
  }
}

// These statuses are necessary checks only, not engine/version/model/profile evidence, token proof, an authenticated LCA lease, or live admission.
export function assertRequiredControlStatuses(controls: unknown, role: ExecutionRole): void {
  if (!(EXECUTION_ROLES as readonly unknown[]).includes(role)) {
    throw new Error("unrecognized execution role")
  }
  if (controls === null || typeof controls !== "object" || Array.isArray(controls)) {
    throw AdmissionRefusal.requiredControlsUnavailable()
  }

  const required: readonly string[] = role === "worker"
    ? [...COMMON_REQUIRED_CONTROLS, ...WORKER_CONTROLS]
    : role === "main" || role === "reviewer"
      ? [...COMMON_REQUIRED_CONTROLS, ...MAIN_REVIEWER_CONTROLS]
      : COMMON_REQUIRED_CONTROLS

  for (const key of required) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(controls, key)
    } catch {
      throw AdmissionRefusal.requiredControlsUnavailable()
    }
    if (!descriptor || !("value" in descriptor) || descriptor.value !== "supported") {
      throw AdmissionRefusal.requiredControlsUnavailable()
    }
  }
}

/** Apply necessary compatibility/control-status checks, not capability or live admission proof. */
export function assertHostAdmission(preflight: Awaited<ReturnType<ExecutionHost["preflight"]>>): void {
  if (!preflight || typeof preflight !== "object" || Array.isArray(preflight)
    || preflight.compatible !== true || !Array.isArray(preflight.problems) || preflight.problems.length !== 0) {
    throw AdmissionRefusal.hostIncompatible()
  }
  for (const role of EXECUTION_ROLES) assertRequiredControlStatuses(preflight.controls, role)
}
