import { describe, expect, test } from "bun:test"
import { assertHostAdmission, assertRequiredControlStatuses } from "../src/hosts/required-controls.ts"
import { AdmissionRefusal } from "../src/hosts/required-controls.ts"
import { EXECUTION_ROLES, WORKFLOW_READ_ONLY_ROLES, type ExecutionHost, type ExecutionRole } from "../src/hosts/types.ts"

const budgetControls = ["boundedInput", "boundedOutput"] as const
const estimatedBudgetControls = ["estimatedInput", "reactiveOutput"] as const
const nonBudgetControls = [
  "preExecutionToolPolicy",
  "headlessPermissionRefusal",
  "ownedCancellation",
  "quiescenceEvidence",
  "identityBinding",
  "noReplayRecovery",
] as const
const common = [...budgetControls, ...nonBudgetControls] as const
const BUDGET_EVIDENCE = {
  input: "estimated",
  output: "reactive",
  vendorContext: "unobserved",
  mainLimit: 8192,
  vendorMainLimit: 49152,
  workerLimit: 5120,
} as const
const commonProfile = "estimated-input-reactive-output-v1" as const
const readOnlyRoles = new Set<ExecutionRole>([
  "main", "reviewer", "interviewer", "planner", "architect", "critic", "researcher", "contrarian", "simplifier",
])

function statuses(role: ExecutionRole): Preflight["controls"] {
  const controls: Preflight["controls"] = Object.fromEntries(common.map(key => [key, "supported" as const]))
  if (role === "worker") controls.serialWorkerLease = "supported"
  if (readOnlyRoles.has(role)) controls.readOnlyWorktree = "supported"
  return controls
}

function estimatedStatuses(role: ExecutionRole): Preflight["controls"] {
  const controls = statuses(role)
  delete controls.boundedInput
  delete controls.boundedOutput
  controls.estimatedInput = "supported"
  controls.reactiveOutput = "supported"
  return controls
}

type Preflight = Awaited<ReturnType<ExecutionHost["preflight"]>>

function preflight(
  controls: Preflight["controls"],
  compatible = true,
  problems: string[] = [],
  budgetEvidence?: Preflight["budgetEvidence"],
): Preflight {
  return { compatible, controls, problems, ...(budgetEvidence === undefined ? {} : { budgetEvidence }) }
}

describe("required control status checks", () => {
  test("each execution role accepts its minimal supported status set", () => {
    for (const role of EXECUTION_ROLES) expect(() => assertRequiredControlStatuses(statuses(role), role)).not.toThrow()
  })

  test("every required status is rejected when missing, malformed, unknown, or unsupported", () => {
    for (const role of EXECUTION_ROLES) {
      const controls = statuses(role)
      const required = [...common,
        ...(role === "worker" ? ["serialWorkerLease"] : []),
        ...(role === "main" || role === "reviewer" ? ["readOnlyWorktree"] : []),
      ]
      for (const key of required) {
        const missing = { ...controls }
        delete missing[key]
        expect(() => assertRequiredControlStatuses(missing, role)).toThrow("required control statuses unavailable")
        for (const value of ["unknown", "unsupported", "invented", null, {}, true]) {
          expect(() => assertRequiredControlStatuses({ ...controls, [key]: value }, role)).toThrow("required control statuses unavailable")
        }
      }
    }
  })

  test.each([...WORKFLOW_READ_ONLY_ROLES])("workflow read-only role %s is refused without readOnlyWorktree", role => {
    const supported = statuses(role)
    expect(supported.readOnlyWorktree).toBe("supported")
    expect(() => assertRequiredControlStatuses(supported, role)).not.toThrow()
    const missing = { ...supported }
    delete missing.readOnlyWorktree
    let refusal: unknown
    try { assertRequiredControlStatuses(missing, role) } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(AdmissionRefusal)
    expect(refusal).toMatchObject({ name: "AdmissionRefusal", message: "required control statuses unavailable" })
    for (const value of ["unsupported", "unknown"]) {
      expect(() => assertRequiredControlStatuses({ ...supported, readOnlyWorktree: value }, role)).toThrow(AdmissionRefusal)
    }
    // The shared host admission checks every role, so one role-specific gap makes the whole host inadmissible.
    const hostControls: Preflight["controls"] = Object.fromEntries(
      [...common, "serialWorkerLease", "readOnlyWorktree"].map(key => [key, "supported" as const]),
    )
    expect(() => assertHostAdmission(preflight(hostControls))).not.toThrow()
    delete hostControls.readOnlyWorktree
    let hostRefusal: unknown
    try { assertHostAdmission(preflight(hostControls)) } catch (error) { hostRefusal = error }
    expect(hostRefusal).toBeInstanceOf(AdmissionRefusal)
    expect(hostRefusal).toMatchObject({ message: "required control statuses unavailable" })
  })

  test("does not accept inherited values or invoke status getters", () => {
    const inherited = Object.create(statuses("main"))
    expect(() => assertRequiredControlStatuses(inherited, "main")).toThrow("required control statuses unavailable")

    let invoked = false
    const withGetter = statuses("worker")
    Object.defineProperty(withGetter, "serialWorkerLease", { get() { invoked = true; return "supported" } })
    expect(() => assertRequiredControlStatuses(withGetter, "worker")).toThrow("required control statuses unavailable")
    expect(invoked).toBe(false)
  })

  test("rejects wrong control containers and runtime-invalid roles", () => {
    for (const controls of [null, undefined, "supported", 1, [], true]) {
      expect(() => assertRequiredControlStatuses(controls, "main")).toThrow("required control statuses unavailable")
    }
    expect(() => Reflect.apply(assertRequiredControlStatuses, undefined, [statuses("main"), "unrecognized"])).toThrow("unrecognized execution role")
  })

  test("extra diagnostics do not supply role-specific requirements", () => {
    expect(() => assertRequiredControlStatuses({ ...statuses("data-analyst"), serialWorkerLease: "supported", readOnlyWorktree: "supported", diagnostics: "supported" }, "data-analyst")).not.toThrow()
    expect(() => assertRequiredControlStatuses({ ...statuses("main"), diagnostics: "supported", readOnlyWorktree: undefined }, "main")).toThrow("required control statuses unavailable")
    expect(() => assertRequiredControlStatuses(statuses("worker"), "main")).toThrow("required control statuses unavailable")
    expect(() => assertRequiredControlStatuses(statuses("main"), "worker")).toThrow("required control statuses unavailable")
  })

  test("estimated and reactive budget statuses are refused by the strict default profile", () => {
    const controls = estimatedStatuses("main")
    expect(() => assertRequiredControlStatuses(controls, "main")).toThrow("required control statuses unavailable")
    expect(() => assertHostAdmission(preflight(controls))).toThrow("required control statuses unavailable")
  })

  test("explicit estimated-input/reactive-output profile keeps nonbudget and role controls required", () => {
    for (const role of EXECUTION_ROLES) {
      expect(() => assertRequiredControlStatuses(estimatedStatuses(role), role, commonProfile)).not.toThrow()
      const required = [
        ...estimatedBudgetControls,
        ...nonBudgetControls,
        ...(role === "worker" ? ["serialWorkerLease"] : []),
        ...(role === "main" || role === "reviewer" ? ["readOnlyWorktree"] : []),
      ]
      for (const key of required) {
        const missing = estimatedStatuses(role)
        delete missing[key]
        expect(() => assertRequiredControlStatuses(missing, role, commonProfile))
          .toThrow("required control statuses unavailable")
        expect(() => assertRequiredControlStatuses({ ...estimatedStatuses(role), [key]: "unsupported" }, role, commonProfile))
          .toThrow("required control statuses unavailable")
      }
    }
  })

  test("unknown control profiles refuse instead of selecting permissive requirements", () => {
    for (const profile of ["unknown", "legacy-unowned", null, false, {}]) {
      expect(() => Reflect.apply(assertRequiredControlStatuses, undefined, [statuses("main"), "main", profile]))
        .toThrow("required control statuses unavailable")
      expect(() => Reflect.apply(assertHostAdmission, undefined, [preflight(statuses("main")), profile]))
        .toThrow("host incompatible")
    }
  })

  test("alternate statuses still require own data properties and do not invoke getters", () => {
    expect(() => assertRequiredControlStatuses(Object.create(estimatedStatuses("main")), "main", commonProfile))
      .toThrow("required control statuses unavailable")

    let invoked = false
    const controls = estimatedStatuses("worker")
    Object.defineProperty(controls, "estimatedInput", { get() { invoked = true; return "supported" } })
    expect(() => assertRequiredControlStatuses(controls, "worker", commonProfile))
      .toThrow("required control statuses unavailable")
    expect(invoked).toBe(false)
  })

  test("common profile admission requires exact own-property budget evidence", () => {
    const controls = Object.fromEntries(
      [...estimatedBudgetControls, ...nonBudgetControls, "serialWorkerLease", "readOnlyWorktree"]
        .map(key => [key, "supported" as const]),
    ) as Preflight["controls"]
    controls.boundedInput = "unsupported"
    controls.boundedOutput = "unsupported"
    expect(() => assertHostAdmission(preflight(controls), commonProfile)).toThrow("host incompatible")
    expect(() => assertHostAdmission(preflight(controls, true, [], BUDGET_EVIDENCE), commonProfile)).not.toThrow()

    const missing: Record<string, unknown> = { ...BUDGET_EVIDENCE }
    delete missing.workerLimit
    const extra = { ...BUDGET_EVIDENCE, exact: true }
    const wrongValue = { ...BUDGET_EVIDENCE, mainLimit: 8191 }
    const wrongVendorValue = { ...BUDGET_EVIDENCE, vendorMainLimit: 32768 }
    let invoked = false
    const getter = { ...BUDGET_EVIDENCE }
    Object.defineProperty(getter, "mainLimit", { get() { invoked = true; return 8192 } })
    const inherited = Object.create(BUDGET_EVIDENCE)
    for (const evidence of [missing, extra, wrongValue, wrongVendorValue, getter, inherited]) {
      expect(() => assertHostAdmission(preflight(controls, true, [], evidence as Preflight["budgetEvidence"]), commonProfile))
        .toThrow("host incompatible")
    }

    const inheritedPreflight = Object.assign(Object.create({ budgetEvidence: BUDGET_EVIDENCE }), {
      compatible: true, controls, problems: [],
    })
    expect(() => assertHostAdmission(inheritedPreflight, commonProfile)).toThrow("host incompatible")
    const getterPreflight = preflight(controls)
    Object.defineProperty(getterPreflight, "budgetEvidence", { get() { invoked = true; return BUDGET_EVIDENCE } })
    expect(() => assertHostAdmission(getterPreflight, commonProfile)).toThrow("host incompatible")
    expect(invoked).toBe(false)
  })

  test("a failing combo route is named by sanitized roles and engine/model only", () => {
    const allRoleControls: Preflight["controls"] = Object.fromEntries(
      [...common, "serialWorkerLease", "readOnlyWorktree"].map(key => [key, "supported" as const]),
    )
    const refusal = (problems: string[]) => {
      try { assertHostAdmission(preflight(allRoleControls, false, problems)) } catch (error) { return error }
      throw new Error("expected host admission refusal")
    }
    const named = refusal([
      "combo route for planner, critic -> claude / opus is unavailable: selected CLI executable or profile is unavailable",
      "private vendor diagnostic",
    ])
    expect(named).toMatchObject({
      name: "AdmissionRefusal",
      message: "host incompatible: required control statuses unavailable; combo route unavailable: planner, critic -> claude / opus",
      comboRoutes: "planner, critic -> claude / opus",
    })
    expect((named as Error).message).not.toContain("private vendor diagnostic")
    // Forged subjects with unknown roles, control characters, or unlisted engines are never echoed.
    for (const forged of [
      "combo route for evil -> claude / opus is unavailable",
      "combo route for planner -> claude / op\u001b[31mus is unavailable",
      "combo route for planner -> bash / opus is unavailable",
      "combo route for planner -> claude / --x\nsecret is unavailable",
    ]) {
      expect(refusal([forged])).toMatchObject({ message: "host incompatible: required control statuses unavailable" })
    }
  })

  test("legacy hook-control maps remain inadmissible under either profile", () => {
    const legacyHookMap: Preflight["controls"] = {
      session: "supported", model: "supported", system: "supported", tools: "supported",
      outputLimit: "supported", thinking: "supported", toolPolicyHandlers: "supported",
      assistantTextHandler: "supported",
    }
    expect(() => assertHostAdmission(preflight(legacyHookMap))).toThrow("required control statuses unavailable")
    expect(() => assertHostAdmission(preflight(legacyHookMap), commonProfile)).toThrow("host incompatible")
  })

  test("shared host admission assertion rejects incompatibility, preflight problems, and missing role controls", () => {
    for (const result of [
      preflight({}, false, ["private vendor diagnostic"]),
      preflight({}, true, ["private vendor diagnostic"]),
    ]) {
      try {
        assertHostAdmission(result)
        throw new Error("expected host admission refusal")
      } catch (error) {
        expect(error).toMatchObject({ message: "host incompatible: required control statuses unavailable" })
        if (!(error instanceof Error)) throw error
        expect(error.message).not.toContain("private vendor diagnostic")
      }
    }

    const allRoleControls: Preflight["controls"] = Object.fromEntries(
      [...common, "serialWorkerLease", "readOnlyWorktree"].map(key => [key, "supported" as const]),
    )
    expect(() => assertHostAdmission(preflight(allRoleControls))).not.toThrow()
    const missingWorkerControl = { ...allRoleControls }
    delete missingWorkerControl.serialWorkerLease
    expect(() => assertHostAdmission(preflight(missingWorkerControl))).toThrow("required control statuses unavailable")
    for (const malformed of [
      null,
      { compatible: "true", controls: allRoleControls, problems: [] },
      { compatible: 1, controls: allRoleControls, problems: [] },
      { compatible: true, controls: allRoleControls, problems: "" },
      { compatible: true, controls: allRoleControls, problems: { length: 0 } },
    ]) {
      expect(() => Reflect.apply(assertHostAdmission, undefined, [malformed])).toThrow("host incompatible")
    }
  })
})
