import { EXECUTION_ROLES, NATIVE_MODEL_ID_RE, isWorkflowReadOnlyRole, type ControlProfile, type ExecutionHost, type ExecutionRole } from "./types.ts"

const LEGACY_BUDGET_CONTROLS = ["boundedInput", "boundedOutput"] as const
const ESTIMATED_REACTIVE_BUDGET_CONTROLS = ["estimatedInput", "reactiveOutput"] as const

const COMMON_REQUIRED_CONTROLS = [
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

const isControlProfile = (value: unknown): value is ControlProfile => value === "estimated-input-reactive-output-v1"
const isObject = (value: unknown): value is object => {
  if (value === null || typeof value !== "object") return false
  try { return !Array.isArray(value) }
  catch { return false }
}

function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function validBudgetEvidence(value: unknown): boolean {
  if (!isObject(value)) return false
  const expected = {
    input: "estimated",
    output: "reactive",
    vendorContext: "unobserved",
    mainLimit: 8192,
    vendorMainLimit: 16384,
    workerLimit: 5120,
  } as const
  try {
    const keys = Reflect.ownKeys(value)
    const expectedKeys = Object.keys(expected)
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) return false
    for (const [key, expectedValue] of Object.entries(expected)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor) || descriptor.value !== expectedValue) return false
    }
    return true
  } catch {
    return false
  }
}

const ROUTE_PROBLEM_RE = /^combo route for ([a-z]+(?:, [a-z]+)*) -> (local|codex|claude) \/ (\S+) is unavailable(?::|$)/

/**
 * Host preflight problems are otherwise withheld from the operator. Only the combo-route subject (role names plus
 * engine/model) is surfaced, rebuilt from validated parts so no vendor diagnostic can pass through.
 */
function comboRouteDetail(problems: unknown): string | undefined {
  try {
    if (!Array.isArray(problems)) return undefined
    const routes: string[] = []
    for (const problem of problems) {
      const match = typeof problem === "string" ? ROUTE_PROBLEM_RE.exec(problem) : null
      if (!match) continue
      const roles = match[1]!.split(", ")
      if (!roles.every(role => (EXECUTION_ROLES as readonly string[]).includes(role)) || !NATIVE_MODEL_ID_RE.test(match[3]!)) continue
      routes.push(`${roles.join(", ")} -> ${match[2]} / ${match[3]}`)
    }
    return routes.length ? routes.join("; ") : undefined
  } catch {
    return undefined
  }
}

export class AdmissionRefusal extends Error {
  /** Sanitized failing combo routes (`role, role -> engine / model; ...`), when the refusal came from a combo route. */
  readonly comboRoutes?: string

  private constructor(message: keyof typeof ADMISSION_REFUSAL_MESSAGES, comboRoutes?: string) {
    super(comboRoutes ? `${ADMISSION_REFUSAL_MESSAGES[message]}; combo route unavailable: ${comboRoutes}` : ADMISSION_REFUSAL_MESSAGES[message])
    this.name = "AdmissionRefusal"
    if (comboRoutes) this.comboRoutes = comboRoutes
  }

  static requiredControlsUnavailable(): AdmissionRefusal {
    return new AdmissionRefusal("requiredControls")
  }

  static hostIncompatible(comboRoutes?: string): AdmissionRefusal {
    return new AdmissionRefusal("hostIncompatible", comboRoutes)
  }
}

// These statuses are necessary checks only, not engine/version/model/profile evidence, token proof, an authenticated Otter lease, or live admission.
export function assertRequiredControlStatuses(controls: unknown, role: ExecutionRole, controlProfile?: ControlProfile): void {
  if (!(EXECUTION_ROLES as readonly unknown[]).includes(role)) {
    throw new Error("unrecognized execution role")
  }
  if (controlProfile !== undefined && !isControlProfile(controlProfile)) {
    throw AdmissionRefusal.requiredControlsUnavailable()
  }
  if (!isObject(controls)) {
    throw AdmissionRefusal.requiredControlsUnavailable()
  }

  const budgetControls = controlProfile === undefined ? LEGACY_BUDGET_CONTROLS : ESTIMATED_REACTIVE_BUDGET_CONTROLS
  const required: readonly string[] = role === "worker"
    ? [...budgetControls, ...COMMON_REQUIRED_CONTROLS, ...WORKER_CONTROLS]
    : role === "main" || role === "reviewer" || isWorkflowReadOnlyRole(role)
      ? [...budgetControls, ...COMMON_REQUIRED_CONTROLS, ...MAIN_REVIEWER_CONTROLS]
      : [...budgetControls, ...COMMON_REQUIRED_CONTROLS]

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
export function assertHostAdmission(
  preflight: Awaited<ReturnType<ExecutionHost["preflight"]>>,
  controlProfile?: ControlProfile,
): void {
  if (controlProfile !== undefined && !isControlProfile(controlProfile)) {
    throw AdmissionRefusal.hostIncompatible()
  }
  if (!isObject(preflight)) {
    throw AdmissionRefusal.hostIncompatible()
  }
  const compatible = ownDataValue(preflight, "compatible")
  const controls = ownDataValue(preflight, "controls")
  const problems = ownDataValue(preflight, "problems")
  let noProblems = false
  try { noProblems = Array.isArray(problems) && problems.length === 0 }
  catch { /* Refuse malformed preflight values without exposing vendor diagnostics. */ }
  if (compatible !== true || !noProblems) {
    throw AdmissionRefusal.hostIncompatible(comboRouteDetail(problems))
  }
  if (controlProfile !== undefined) {
    const evidence = ownDataValue(preflight, "budgetEvidence")
    if (!validBudgetEvidence(evidence)) throw AdmissionRefusal.hostIncompatible()
  }
  for (const role of EXECUTION_ROLES) assertRequiredControlStatuses(controls, role, controlProfile)
}
