import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  classifyCapability, isGenuineCompletedQuiescentTrainerResult,
  type ExecutableIdentity, type OwnedWorkerResult, type SkillOptContainmentReceipt, type SkillOptWorkerProfile,
} from "../src/skillopt/host.ts"
import { sha256 } from "../src/skillopt/pilot.ts"

const identity = (version: string): ExecutableIdentity => ({ launcherSha256: "a".repeat(64), observedVersion: version, basis: "resolved-launcher-file-and-version-command" })
const root = resolve(import.meta.dir, "../..")
const cli = resolve(root, "scripts/otter-skillopt.ts")

test("fixed public listener is not accepted as fixed internal runner containment", () => {
  const receipt = classifyCapability(identity("1.18.33"), identity("0.34.3"), true)
  expect(receipt.schema).toBe("skillopt.capability.v1")
  expect(receipt.code).toBe("isolation_unavailable")
  expect(receipt.reason).toContain("ephemeral internal runner port")
  expect(receipt.reason).toContain("fixed outer OLLAMA_HOST does not satisfy")
  expect(receipt.actualRoleContainment).toBe("unverified")
  expect(receipt.liveSkillWitness).toBe("unverified")
  expect(receipt.originalLoadedByteAttestation).toBe(false)
  expect(receipt.experimentAdmitted).toBe(false)
  expect(receipt.evidence).toHaveLength(3)
})

test("runtime drift and missing sandbox cannot be reclassified as supported", () => {
  expect(classifyCapability(identity("1.18.32"), identity("0.34.3"), true).code).toBe("runtime_version_mismatch")
  expect(classifyCapability(identity("1.18.33"), identity("0.34.4"), true).code).toBe("runtime_version_mismatch")
  expect(classifyCapability(identity("1.18.33"), identity("0.34.3"), false).code).toBe("sandbox_unavailable")
})

test("caller-built and cloned completions cannot satisfy trainer closure provenance", () => {
  const forged = Object.freeze({ status: "completed", exitCode: 0, signal: null, quiescent: true,
    stdoutBytes: 0, stderrBytes: 0, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) }) as OwnedWorkerResult
  const profile = undefined as unknown as SkillOptWorkerProfile
  const receipt = undefined as unknown as SkillOptContainmentReceipt
  expect(isGenuineCompletedQuiescentTrainerResult(forged, profile, receipt)).toBe(false)
  expect(isGenuineCompletedQuiescentTrainerResult(Object.freeze({ ...forged }), profile, receipt)).toBe(false)
})

test("snapshot CLI emits only hash-bound metadata and preserves production skill", () => {
  const target = resolve(root, ".agents/skills/llm-wiki/SKILL.md")
  const before = sha256(readFileSync(target))
  const result = spawnSync(process.execPath, [cli, "snapshot", "--root", root], { encoding: "utf8", timeout: 10000 })
  expect(result.status).toBe(0)
  const output = JSON.parse(result.stdout)
  expect(output.snapshot.originalSkillSha256).toBe(before)
  expect(output.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.stdout).not.toContain(root)
  expect(sha256(readFileSync(target))).toBe(before)
})

test("unimplemented or authority-bearing phases are not accepted as successful no-ops", () => {
  for (const args of [["apply"], ["optimize"], ["preflight", "--approved", "true"], ["snapshot", "--unknown"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000 })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(args[0] === "apply" || args[0] === "optimize" ? "사용법:" : "Usage:")
  }
})
