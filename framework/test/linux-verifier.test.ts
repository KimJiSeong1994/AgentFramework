import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { createLinuxVerifierExecutor } from "../src/orchestration/linux-verifier.ts"
import { inspectLinuxVerifierProfile } from "../src/hosts/linux-domain.ts"
import type { VerificationReference, VerificationRequest } from "../src/orchestration/verifier.ts"

const snapshotID = "a".repeat(40)
const reference: VerificationReference = {
  kind: "verifier", executionID: "execution-1", profile: "linux-single-use",
  invocationID: "2".repeat(32), inputSnapshotID: snapshotID,
  inputDigest: createHash("sha256").update(snapshotID).digest("hex"), deadlineAt: Date.now() + 30_000,
  maxOutputChars: 256, unit: "lca-verifier.service", bootID: "11111111-1111-4111-8111-111111111111",
}

function request(overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    executionID: "execution-1", supervisorSessionID: "session-1", taskID: "task-1", attemptID: "attempt-1",
    generation: 1, command: "printf exact command", cwd: "/workspace/project", inputSnapshotID: snapshotID,
    inputDigest: reference.inputDigest, inputArchive: Uint8Array.of(1, 2, 3), deadlineAt: Date.now() + 30_000,
    maxOutputChars: 256, env: { SECRET: "must-not-be-forwarded" }, profile: "linux-single-use", ...overrides,
  }
}

test("preflight never enables Linux verification from an absent or unqualified default authority", async () => {
  const production = await createLinuxVerifierExecutor().preflight("linux-single-use")
  const qualification = await createLinuxVerifierExecutor({ qualification: true }).preflight("linux-single-use")
  if (process.platform !== "linux" || !inspectLinuxVerifierProfile(true).compatible) {
    expect(production.compatible).toBe(false)
    expect(qualification.compatible).toBe(false)
  }
  expect(await createLinuxVerifierExecutor().preflight("legacy-unowned")).toMatchObject({ compatible: false })
  expect(() => createLinuxVerifierExecutor({ qualification: "yes" as unknown as boolean })).toThrow(TypeError)
})

test("prepare is inert and refuses missing, malformed or unbounded immutable snapshot input", async () => {
  const executor = createLinuxVerifierExecutor({ qualification: true })
  await expect(executor.prepare(request({ inputArchive: undefined }))).rejects.toThrow(/input archive/)
  await expect(executor.prepare(request({ inputArchive: new Uint8Array(16 * 1024 * 1024 + 1) }))).rejects.toThrow(/input archive/)
  await expect(executor.prepare(request({ inputDigest: "f".repeat(64) }))).rejects.toThrow(/invalid Linux verifier request/)
  await expect(executor.prepare(request({ command: "x\0y" }))).rejects.toThrow(/invalid Linux verifier request/)
  await expect(executor.prepare(request({ maxOutputChars: 65_537 }))).rejects.toThrow(/invalid Linux verifier request/)
})

test("native preparation and reconciliation refuse when the root authority is absent", async () => {
  if (process.platform === "linux" && inspectLinuxVerifierProfile(true).compatible) return
  const executor = createLinuxVerifierExecutor({ qualification: true })
  await expect(executor.prepare(request())).rejects.toThrow()
  const reconciliation = await executor.reconcile(reference)
  expect(reconciliation).toEqual({ outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown" })
})

test("old references carrying mutable native cgroup identity are rejected, never adopted", async () => {
  const executor = createLinuxVerifierExecutor({ qualification: true })
  await expect(executor.reconcile({ ...reference, cgroupInode: "42" } as VerificationReference)).rejects.toThrow(TypeError)
})
