import { describe, expect, test } from "bun:test"
import { assertHostAdmission, assertRequiredControlStatuses } from "../src/hosts/required-controls.ts"
import { EXECUTION_ROLES, type ExecutionHost, type ExecutionRole } from "../src/hosts/types.ts"

const common = [
  "boundedInput",
  "boundedOutput",
  "preExecutionToolPolicy",
  "headlessPermissionRefusal",
  "ownedCancellation",
  "quiescenceEvidence",
  "identityBinding",
  "noReplayRecovery",
] as const

function statuses(role: ExecutionRole): Record<string, unknown> {
  const controls: Record<string, unknown> = Object.fromEntries(common.map(key => [key, "supported"]))
  if (role === "worker") controls.serialWorkerLease = "supported"
  if (role === "main" || role === "reviewer") controls.readOnlyWorktree = "supported"
  return controls
}

type Preflight = Awaited<ReturnType<ExecutionHost["preflight"]>>

function preflight(controls: Preflight["controls"], compatible = true, problems: string[] = []): Preflight {
  return { compatible, controls, problems }
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
