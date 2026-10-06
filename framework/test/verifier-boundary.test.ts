import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import type { VerificationReconciliation, VerificationRequest } from "../src/orchestration/verifier.ts"

function request(cwd: string, command: string, overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    executionID: "execution-1", supervisorSessionID: "session-1", taskID: "task-1",
    attemptID: "attempt-1", generation: 1, command, cwd,
    inputSnapshotID: "snapshot-1", inputDigest: "a".repeat(64),
    deadlineAt: Date.now() + 10_000, maxOutputChars: 32, env: {}, profile: "legacy-unowned",
    ...overrides,
  }
}

const unknown: VerificationReconciliation = {
  outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown",
}

test("prepare is inert, references are unique and bound to the supplied input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-verifier-"))
  try {
    const marker = join(dir, "marker")
    const executor = createLegacyVerifierExecutor()
    const input = request(dir, "printf done > marker; printf output")
    const first = await executor.prepare(input)
    const second = await executor.prepare({ ...input, inputDigest: "b".repeat(64) })
    expect(existsSync(marker)).toBe(false)
    expect(first.reference).toMatchObject({
      kind: "verifier", profile: "legacy-unowned", executionID: input.executionID,
      inputSnapshotID: input.inputSnapshotID, inputDigest: input.inputDigest,
      deadlineAt: input.deadlineAt, maxOutputChars: input.maxOutputChars,
    })
    expect(first.reference.invocationID).not.toBe(second.reference.invocationID)
    expect(second.reference.inputDigest).toBe("b".repeat(64))
    expect(await first.run()).toMatchObject({
      profile: "legacy-unowned", parentExit: 0, timedOut: false, cancelled: false,
      isolationEstablished: false, domainState: "unknown", integrity: "unknown", output: "output",
    })
    expect(readFileSync(marker, "utf8")).toBe("done")
    expect(await first.run()).toMatchObject({ parentExit: 0, output: "output" })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("legacy output honors the budget and command receives the requested environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-verifier-"))
  const inherited = process.env.LEGACY_BOUNDARY_INHERITED
  process.env.LEGACY_BOUNDARY_INHERITED = "not-allowed"
  try {
    const handle = await createLegacyVerifierExecutor().prepare(request(dir, "test -z \"$LEGACY_BOUNDARY_INHERITED\" && printf '%s' \"$LEGACY_BOUNDARY_INPUT\"", {
      env: { LEGACY_BOUNDARY_INPUT: "abcdefghijklmnopqrstuvwxyz" }, maxOutputChars: 8,
    }))
    const result = await handle.run()
    expect(result.parentExit).toBe(0)
    expect(result.output).toBe("…tuvwxyz")
    expect(result.output.length).toBeLessThanOrEqual(8)
    expect(result.integrity).toBe("unknown")
    expect(result.proof).toBeUndefined()
  } finally {
    if (inherited === undefined) delete process.env.LEGACY_BOUNDARY_INHERITED
    else process.env.LEGACY_BOUNDARY_INHERITED = inherited
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Linux profile is refused and malformed or mismatched references cannot establish proof", async () => {
  const executor = createLegacyVerifierExecutor()
  expect(await executor.preflight("legacy-unowned")).toEqual({ compatible: true, problems: [] })
  expect(await executor.preflight("linux-single-use")).toMatchObject({ compatible: false })
  await expect(executor.prepare(request(tmpdir(), "exit 0", { profile: "linux-single-use" }))).rejects.toThrow(/unsupported/)
  const handle = await executor.prepare(request(tmpdir(), "exit 0"))
  await expect(executor.reconcile({ ...handle.reference, profile: "linux-single-use" })).rejects.toThrow(TypeError)
  await expect(executor.reconcile({ ...handle.reference, unit: "foreign" })).rejects.toThrow(TypeError)
  await expect(executor.reconcile({ ...handle.reference, inputDigest: "" })).rejects.toThrow(TypeError)
  expect(await executor.reconcile(handle.reference)).toEqual(unknown)
  expect(await createLegacyVerifierExecutor().reconcile(handle.reference)).toEqual(unknown)
})

test("cancellation requests are not acknowledged as family proof", async () => {
  const executor = createLegacyVerifierExecutor()
  const handle = await executor.prepare(request(tmpdir(), "exec /bin/sleep 10"))
  const running = handle.run()
  expect(await handle.requestCancel("stop", Date.now() + 1000)).toEqual({ requested: true, acknowledged: false })
  const result = await running
  expect(result).toMatchObject({ cancelled: true, isolationEstablished: false, domainState: "unknown", integrity: "unknown" })
  expect(await handle.reconcile()).toEqual(unknown)
  expect(await executor.reconcile(handle.reference)).toEqual(unknown)
})

test("deadline timeout is reported as timeout, not cancellation or family proof", async () => {
  const handle = await createLegacyVerifierExecutor().prepare(request(tmpdir(), "exec /bin/sleep 10", {
    deadlineAt: Date.now() + 100,
  }))
  expect(await handle.run()).toMatchObject({
    timedOut: true, cancelled: false, isolationEstablished: false,
    domainState: "unknown", integrity: "unknown",
  })
})

test("cancelling before run never spawns the command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-verifier-"))
  try {
    const handle = await createLegacyVerifierExecutor().prepare(request(dir, "printf started > marker"))
    expect(await handle.requestCancel("stop", Date.now() + 1000)).toEqual({ requested: true, acknowledged: false })
    expect(() => handle.run()).toThrow(/cancelled before launch/)
    expect(existsSync(join(dir, "marker"))).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
