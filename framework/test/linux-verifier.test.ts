import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { createLinuxVerifierExecutor } from "../src/orchestration/linux-verifier.ts"
import { inspectLinuxVerifierProfile } from "../src/hosts/linux-domain.ts"
import type { VerificationPreflight, VerificationReference, VerificationRequest } from "../src/orchestration/verifier.ts"

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

function mockedPreflight(response: Record<string, unknown>, localCompatible = false): {
  preflight: VerificationPreflight
  legacy: VerificationPreflight
  diagnosticQualifications: boolean[]
} {
  const linuxDomainModule = fileURLToPath(new URL("../src/hosts/linux-domain.ts", import.meta.url))
  const linuxVerifierModule = fileURLToPath(new URL("../src/orchestration/linux-verifier.ts", import.meta.url))
  const source = `import { mock } from "bun:test";
const diagnosticQualifications = [];
mock.module(${JSON.stringify(linuxDomainModule)}, () => ({
  authenticateLinuxVerification() { return false; },
  inspectLinuxVerifierProfile(qualification) {
    if (qualification !== false) throw new Error("unexpected execution qualification mode");
    return { compatible: ${JSON.stringify(localCompatible)}, problems: ${JSON.stringify(localCompatible ? [] : ["root verifier profile is not qualified for production"])} };
  },
  isCurrentLinuxVerifierReference() { return false; },
  runLinuxVerifierClient(operation, _data, deadlineAt, qualification) {
    if (operation !== "preflight" || qualification !== true || deadlineAt <= Date.now()) {
      throw new Error("preflight did not use bounded diagnostic-only qualification");
    }
    diagnosticQualifications.push(qualification);
    return Promise.resolve(${JSON.stringify(response)});
  },
}));
const { createLinuxVerifierExecutor } = await import(${JSON.stringify(linuxVerifierModule)});
const executor = createLinuxVerifierExecutor();
const preflight = await executor.preflight("linux-single-use");
const legacy = await executor.preflight("legacy-unowned");
console.log(JSON.stringify({ preflight, legacy, diagnosticQualifications }));`
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  })
  if (child.error || child.status !== 0) {
    throw new Error(`mocked Linux preflight subprocess failed: ${child.error?.message ?? child.stderr}`)
  }
  return JSON.parse(child.stdout) as ReturnType<typeof mockedPreflight>
}

function healthyAdmission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bootEpochMatch: true,
    journal: { persistentEffective: true, persistentEntry: true, readable: true },
    pendingTickets: 0,
    pendingBytes: 0,
    unknownBound: 0,
    staleActive: 0,
    latched: false,
    quarantineRequired: false,
    capacityAvailable: true,
    reasons: [],
    ...overrides,
  }
}

function rootPreflight(admission: Record<string, unknown>, compatible = true): Record<string, unknown> {
  return { ok: true, compatible, problems: [], admission }
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

test("Linux preflight fails closed when root health is missing or malformed", () => {
  const malformed = healthyAdmission({ pendingBytes: "0" })
  for (const response of [
    { ok: true, compatible: true, problems: [] },
    rootPreflight(malformed),
  ]) {
    const result = mockedPreflight(response)
    expect(result.preflight.compatible).toBe(false)
    expect(result.preflight.admission).toBeUndefined()
    expect(result.preflight.problems).toContain("root verifier profile is not qualified for production")
    expect(result.preflight.problems).toContain("Linux verifier gate returned an invalid preflight health response")
    expect(result.diagnosticQualifications).toEqual([true])
  }
})

test("Linux preflight exposes unqualified profile refusal and latched native health together", () => {
  const admission = healthyAdmission({ latched: true, quarantineRequired: true, reasons: ["latched"] })
  const result = mockedPreflight({
    ...rootPreflight(admission, false),
    problems: ["native Linux verifier admission is latched"],
  })
  expect(result.preflight.compatible).toBe(false)
  expect(result.preflight.problems).toContain("root verifier profile is not qualified for production")
  expect(result.preflight.problems).toContain("native Linux verifier admission is latched")
  expect(result.preflight.problems).toContain("Linux admission health reasons: latched")
  expect(result.preflight.admission).toMatchObject({ latched: true, quarantineRequired: true, reasons: ["latched"] })
  expect(result.diagnosticQualifications).toEqual([true])
  expect(result.legacy.compatible).toBe(false)
  expect(result.legacy.problems[0]).toContain("unsupported verifier profile")
})

test("transient capacity exhaustion remains diagnostic and does not make preflight incompatible", () => {
  const admission = healthyAdmission({ capacityAvailable: false })
  const result = mockedPreflight(rootPreflight(admission), true)
  expect(result.preflight).toMatchObject({ compatible: true, admission: { capacityAvailable: false } })
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
