import { expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createExecutionRunStore, ExecutionRunBusyError, ExecutionRunCorruptError, ExecutionRunUnresolvedError, hostRecoveryContext, persistedHostReference, settled, strictQuiescent } from "../src/hosts/run-state.ts"
import type { ExecutionReference } from "../src/hosts/types.ts"
import type { VerificationReference, VerificationResult } from "../src/orchestration/verifier.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { tempExecutionAuthority } from "./guards-helpers.ts"

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "run-state-"))
  const worktree = join(home, "worktree")
  mkdirSync(worktree)
  const envKeys = ["HOME", "XDG_STATE_HOME", "LCA_STATE_HOME"] as const
  const prior = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, LCA_STATE_HOME: process.env.LCA_STATE_HOME }
  const restoreEnv = () => {
    for (const key of envKeys) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
  }
  process.env.HOME = home
  process.env.XDG_STATE_HOME = home
  process.env.LCA_STATE_HOME = home
  let authority: ReturnType<typeof tempExecutionAuthority> | undefined
  let store: ReturnType<typeof createExecutionRunStore>
  try {
    authority = tempExecutionAuthority(worktree)
    store = createExecutionRunStore(worktree)
  } catch (error) {
    authority?.release({ preserve: true })
    restoreEnv()
    throw new Error(`run-state fixture setup failed; worktree retained at ${worktree}; home retained at ${home}${authority ? `; execution authority retained at ${authority.keyDirectory}` : ""}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!authority) throw new Error("execution-authority fixture was not allocated")
  const fixtureAuthority = authority
  const fixtureStore = store
  return {
    home, worktree, executionDirectory: fixtureAuthority.directory, store: fixtureStore,
    cleanup() {
      const released = fixtureAuthority.release({ preserve: false })
      restoreEnv()
      if (!released.removed) {
        throw new Error(`execution authority retained at ${released.path}; worktree retained at ${worktree}; home retained at ${home}: ${released.reason ?? "release refused"}`)
      }
      rmSync(home, { recursive: true, force: true })
    },
  }
}
const baseIntent = (claim: ReturnType<ReturnType<typeof createExecutionRunStore>["claim"]>, executionId: string) => ({ executionId, ownerSession: claim.ownerSession, taskId: "task", attemptId: "attempt", generation: claim.generation, role: "worker", cwd: "/tmp", policyID: "fixture-fixed-policy" })
const intent = (claim: ReturnType<ReturnType<typeof createExecutionRunStore>["claim"]>, executionId: string) => ({ ...baseIntent(claim, executionId), kind: "host" as const, engine: "opencode", profile: "legacy-unowned" as const })
const verifierInput = { inputSnapshotID: "snapshot-1", inputDigest: "a".repeat(64), deadlineAt: 100000, maxOutputChars: 4000 }
const verifierIntent = (claim: ReturnType<ReturnType<typeof createExecutionRunStore>["claim"]>, executionId: string, profile: "legacy-unowned" | "linux-single-use" = "legacy-unowned") => ({ ...baseIntent(claim, executionId), kind: "verifier" as const, profile, ...verifierInput })
const verifierRef = (executionID: string, profile: "legacy-unowned" | "linux-single-use"): VerificationReference => ({ kind: "verifier", executionID, profile, invocationID: `invocation-${executionID}`, ...verifierInput, ...(profile === "linux-single-use" ? { unit: "lca-verifier.service", bootID: "boot" } : {}) })
const verification = (reference: VerificationReference): VerificationResult => ({ profile: reference.profile, parentExit: 0, timedOut: false, cancelled: false, isolationEstablished: reference.profile === "linux-single-use", domainState: reference.profile === "linux-single-use" ? "empty" : "unknown", integrity: "unchanged", output: "ok", proof: { reference, evidence: "boundary verified" } })

test("run state rejects stale generations and ACK does not establish quiescence", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "e1"))
    f.store.recordCancel(c, "e1", { requestedAt: 1, acknowledgedAt: 2 })
    expect(() => f.store.assertQuiescent(c)).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.reconcile(c, "e1", { outcome: "unknown", quiescent: true, evidence: "claimed stopped" })).toThrow(TypeError)
    expect(() => f.store.reconcile(c, "e1", { outcome: "running", quiescent: true, evidence: "claimed stopped" })).toThrow(TypeError)
    expect(() => f.store.assertQuiescent(c)).toThrow(ExecutionRunUnresolvedError)
    f.store.reconcile(c, "e1", { outcome: "terminal", quiescent: true, evidence: "confirmed stopped" })
    f.store.release(c)
    const newer = f.store.claim("session-2", "instance", process.pid)
    expect(() => f.store.fence(c, "e1", "stale event")).toThrow(ExecutionRunBusyError)
    expect(f.store.status().claim?.generation).toBe(newer.generation)
  } finally { f.cleanup() }
})

test("host vendor reference binding is immutable and refused changes do not persist", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    const reference: ExecutionReference = {
      executionID: "host", vendorSessionID: "session-host", vendorThreadID: "thread-host", vendorTurnID: "turn-host",
    }
    f.store.registerIntent(claim, intent(claim, "host"))
    f.store.bindVendorRef(claim, "host", JSON.stringify(reference))
    const bound = readFileSync(path)

    f.store.bindVendorRef(claim, "host", JSON.stringify(reference))
    expect(readFileSync(path)).toEqual(bound)

    expect(() => f.store.bindVendorRef(claim, "host", JSON.stringify({ ...reference, vendorTurnID: "changed-turn" })))
      .toThrow(TypeError)
    expect(readFileSync(path)).toEqual(bound)
    expect(f.store.status().executions[0]?.vendorRef).toBe(JSON.stringify(reference))
  } finally { f.cleanup() }
})

test("host vendor reference binding refuses execution-only IDs and invalid first-bind authority", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    f.store.registerIntent(claim, intent(claim, "host"))
    const beforeExecutionOnly = readFileSync(path)
    expect(() => f.store.bindVendorRef(claim, "host", JSON.stringify({ executionID: "host" }))).toThrow(TypeError)
    expect(readFileSync(path)).toEqual(beforeExecutionOnly)

    f.store.recordTerminal(claim, "host", { outcome: "completed", terminalAt: 1 })
    const beforeTerminalBind = readFileSync(path)
    expect(() => f.store.bindVendorRef(claim, "host", JSON.stringify({ executionID: "host", vendorSessionID: "session-host" })))
      .toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(beforeTerminalBind)
  } finally { f.cleanup() }

  const stale = fixture()
  try {
    const old = stale.store.claim("old-owner", "old-instance", process.pid)
    stale.store.registerIntent(old, intent(old, "old-host"))
    const path = join(stale.executionDirectory, "state.json")
    stale.store.recordTerminal(old, "old-host", { outcome: "completed", terminalAt: 1, quiescentAt: 2 })
    stale.store.release(old)
    const current = stale.store.claim("new-owner", "new-instance", process.pid)
    const beforeStaleBind = readFileSync(path)
    expect(() => stale.store.bindVendorRef(current, "old-host", JSON.stringify({
      executionID: "old-host", vendorSessionID: "session-old-host",
    }))).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(beforeStaleBind)
  } finally { stale.cleanup() }
})

test("late first host reference is recovery evidence after cancel or fence", () => {
  for (const blockedBy of ["cancel", "fence"] as const) {
    const f = fixture()
    try {
      const claim = f.store.claim("owner", "instance", process.pid)
      f.store.registerIntent(claim, intent(claim, "host"))
      f.store.markHostDispatched(claim, "host")
      if (blockedBy === "cancel") f.store.recordCancel(claim, "host", { requestedAt: 1 })
      else f.store.fence(claim, "host", "recovery fence")
      const reference = { executionID: "host", vendorSessionID: "late-session" }
      f.store.bindVendorRef(claim, "host", JSON.stringify(reference))
      expect(f.store.status().executions[0]).toMatchObject({
        hostDispatch: "started", vendorRef: JSON.stringify(reference), boundaryRef: reference,
        ...(blockedBy === "cancel" ? { cancel: { requestedAt: 1 } } : { fence: { reason: "recovery fence" } }),
      })
    } finally { f.cleanup() }
  }
})

test("host engine identity is required at registration and forbidden on verifier intents", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    const before = readFileSync(path)
    const valid = intent(claim, "host")
    const withoutEngine = { ...valid }
    delete (withoutEngine as Partial<typeof valid>).engine
    for (const invalid of [
      withoutEngine,
      { ...valid, engine: "" },
      { ...valid, engine: "x".repeat(513) },
      { ...valid, engine: 42 },
    ]) {
      expect(() => f.store.registerIntent(claim, invalid as any)).toThrow(TypeError)
      expect(readFileSync(path)).toEqual(before)
    }

    expect(() => f.store.registerIntent(claim, { ...verifierIntent(claim, "verify"), engine: "opencode" } as any))
      .toThrow(TypeError)
    expect(readFileSync(path)).toEqual(before)
    f.store.registerIntent(claim, verifierIntent(claim, "verify"))
    expect(f.store.status().executions[0]).not.toHaveProperty("engine")
  } finally { f.cleanup() }
})

test("host control profile persists separately from the containment profile", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    const before = readFileSync(path)
    const valid = { ...intent(claim, "host"), controlProfile: "estimated-input-reactive-output-v1" as const }

    for (const controlProfile of ["unknown", "legacy-unowned", null, undefined]) {
      expect(() => f.store.registerIntent(claim, { ...valid, controlProfile } as any)).toThrow(TypeError)
      expect(readFileSync(path)).toEqual(before)
    }
    expect(() => f.store.registerIntent(claim, {
      ...verifierIntent(claim, "verify"), controlProfile: "estimated-input-reactive-output-v1",
    } as any)).toThrow(TypeError)
    expect(readFileSync(path)).toEqual(before)

    f.store.registerIntent(claim, valid)
    expect(f.store.status().executions[0]).toMatchObject({
      kind: "host", profile: "legacy-unowned", controlProfile: "estimated-input-reactive-output-v1",
    })
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { executions: Array<Record<string, unknown>> }
    expect(persisted.executions[0]).toMatchObject({
      kind: "host", profile: "legacy-unowned", controlProfile: "estimated-input-reactive-output-v1",
    })
  } finally { f.cleanup() }
})

test("persisted control profiles are rejected on verifier and legacy shapeless records", () => {
  const verifierFixture = fixture()
  try {
    const claim = verifierFixture.store.claim("owner", "instance", process.pid)
    const path = join(verifierFixture.executionDirectory, "state.json")
    verifierFixture.store.registerIntent(claim, verifierIntent(claim, "verify"))
    const state = JSON.parse(readFileSync(path, "utf8")) as { executions: Array<Record<string, unknown>> }
    state.executions[0]!.controlProfile = "estimated-input-reactive-output-v1"
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path)
    expect(() => verifierFixture.store.status()).toThrow(ExecutionRunCorruptError)
    expect(readFileSync(path)).toEqual(before)
  } finally { verifierFixture.cleanup() }

  const legacyFixture = fixture()
  try {
    const claim = legacyFixture.store.claim("owner", "instance", process.pid)
    const path = join(legacyFixture.executionDirectory, "state.json")
    legacyFixture.store.registerIntent(claim, intent(claim, "host"))
    const state = JSON.parse(readFileSync(path, "utf8")) as { executions: Array<Record<string, unknown>> }
    delete state.executions[0]!.kind
    delete state.executions[0]!.profile
    state.executions[0]!.controlProfile = "estimated-input-reactive-output-v1"
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path)
    expect(() => legacyFixture.store.status()).toThrow(ExecutionRunCorruptError)
    expect(readFileSync(path)).toEqual(before)
  } finally { legacyFixture.cleanup() }
})

test("old and malformed host engine identities are rejected on disk without rewriting the store", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    f.store.registerIntent(claim, intent(claim, "host"))
    f.store.bindVendorRef(claim, "host", JSON.stringify({ executionID: "host", vendorSessionID: "session-host" }))
    const validState = readFileSync(path, "utf8")
    const invalidEngines: Array<(record: Record<string, unknown>) => void> = [
      record => { delete record.engine },
      record => { record.engine = "" },
      record => { record.engine = "x".repeat(513) },
      record => { record.engine = 42 },
    ]
    for (const invalidate of invalidEngines) {
      const state = JSON.parse(validState) as { executions: Array<Record<string, unknown>> }
      invalidate(state.executions[0]!)
      writeFileSync(path, JSON.stringify(state))
      const before = readFileSync(path)
      expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
      expect(readFileSync(path)).toEqual(before)
    }
  } finally { f.cleanup() }
})

test("persisted verifier records reject an engine field without changing their profile schema", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    f.store.registerIntent(claim, verifierIntent(claim, "verify", "legacy-unowned"))
    expect(f.store.status().executions[0]).toMatchObject({
      kind: "verifier", profile: "legacy-unowned", verifierDispatch: "prepared",
    })
    const state = JSON.parse(readFileSync(path, "utf8")) as { executions: Array<Record<string, unknown>> }
    state.executions[0]!.engine = "opencode"
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path)
    expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
    expect(readFileSync(path)).toEqual(before)
  } finally { f.cleanup() }
})

test("host vendor reference binding rejects duplicate session, thread, and turn IDs", () => {
  for (const field of ["vendorSessionID", "vendorThreadID", "vendorTurnID"] as const) {
    const f = fixture()
    try {
      const claim = f.store.claim("owner", "instance", process.pid)
      const path = join(f.executionDirectory, "state.json")
      const sharedID = `duplicate-${field}`
      const firstReference = { executionID: "first", [field]: sharedID } as ExecutionReference
      f.store.registerIntent(claim, intent(claim, "first"))
      f.store.bindVendorRef(claim, "first", JSON.stringify(firstReference))
      f.store.recordTerminal(claim, "first", { outcome: "completed", terminalAt: 1, quiescentAt: 2 })
      f.store.registerIntent(claim, intent(claim, "second"))

      const duplicate = { executionID: "second", [field]: sharedID } as ExecutionReference
      const before = readFileSync(path)
      expect(() => f.store.bindVendorRef(claim, "second", JSON.stringify(duplicate)))
        .toThrow(ExecutionRunUnresolvedError)
      expect(readFileSync(path)).toEqual(before)
    } finally { f.cleanup() }
  }
})

test("host vendor reference binding rejects stale and foreign claims without persisting", () => {
  const f = fixture()
  try {
    const stale = f.store.claim("owner", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    f.store.registerIntent(stale, intent(stale, "first"))
    f.store.bindVendorRef(stale, "first", JSON.stringify({ executionID: "first", vendorSessionID: "session-first" }))
    f.store.recordTerminal(stale, "first", { outcome: "completed", terminalAt: 1, quiescentAt: 2 })
    f.store.release(stale)

    const current = f.store.claim("next-owner", "instance", process.pid)
    f.store.registerIntent(current, intent(current, "second"))
    const before = readFileSync(path)
    expect(() => f.store.bindVendorRef(stale, "second", JSON.stringify({ executionID: "second", vendorSessionID: "session-second" })))
      .toThrow(ExecutionRunBusyError)
    expect(readFileSync(path)).toEqual(before)

    const foreignOwner = { ...current, ownerSession: "foreign-owner" }
    expect(() => f.store.bindVendorRef(foreignOwner, "second", JSON.stringify({ executionID: "second", vendorSessionID: "session-second" })))
      .toThrow(ExecutionRunBusyError)
    expect(readFileSync(path)).toEqual(before)
  } finally { f.cleanup() }
})

test("generic host recovery context validates current ownership, reference, cwd, role, and policy", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    const reference: ExecutionReference = { executionID: "host", vendorSessionID: "session-host", vendorThreadID: "thread-host" }
    f.store.registerIntent(claim, intent(claim, "host"))
    f.store.bindVendorRef(claim, "host", JSON.stringify(reference))
    const state = f.store.status()
    const fixedPolicyID = (role: string) => role === "worker" ? "fixture-fixed-policy" : "unknown-policy"
    const invalid = (
      change: (value: typeof state) => void,
      candidate: ExecutionReference = reference,
    ) => {
      const value = structuredClone(state)
      change(value)
      return hostRecoveryContext(value, candidate, "opencode", fixedPolicyID)
    }

    expect(hostRecoveryContext(state, reference, "opencode", fixedPolicyID)).toEqual({
      executionID: "host", engine: "opencode", ownerSession: "owner", cwd: "/tmp", role: "worker",
      policyID: "fixture-fixed-policy", profile: "legacy-unowned", processRisk: false,
    })
    expect(persistedHostReference(state.executions[0]!)).toEqual(reference)
    const driftedBoundary = structuredClone(state.executions[0]!)
    driftedBoundary.boundaryRef = { ...reference, vendorSessionID: "different-session" }
    expect(persistedHostReference(driftedBoundary)).toBeUndefined()
    expect(invalid(value => { delete value.claim })).toBeUndefined()
    expect(invalid(value => { value.claim!.generation-- })).toBeUndefined()
    expect(invalid(value => { value.claim!.ownerSession = "foreign-owner" })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.ownerSession = "foreign-owner" })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.generation = value.generation + 1 })).toBeUndefined()
    expect(invalid(value => { value.executions.push({ ...value.executions[0]! }) })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.cwd = "relative/worktree" })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.cwd = "/tmp/../tmp" })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.role = "unknown-role" })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.policyID = "foreign-policy" })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.boundaryRef = { ...reference, vendorThreadID: "changed-thread" } })).toBeUndefined()
    expect(invalid(value => { value.executions[0]!.vendorRef = JSON.stringify({ ...reference, vendorTurnID: "changed-turn" }) })).toBeUndefined()
    expect(invalid(value => {
      delete value.executions[0]!.vendorRef
      delete value.executions[0]!.boundaryRef
    })).toBeUndefined()
    expect(invalid(() => {}, { ...reference, vendorThreadID: "foreign-thread" })).toBeUndefined()

    for (const field of ["vendorThreadID", "vendorTurnID"] as const) {
      const duplicate = structuredClone(state)
      const sharedID = `shared-${field}`
      const firstReference = { ...reference, [field]: sharedID }
      duplicate.executions[0]!.vendorRef = JSON.stringify(firstReference)
      duplicate.executions[0]!.boundaryRef = firstReference
      duplicate.executions.push({
        ...duplicate.executions[0]!,
        executionId: "other-host",
        vendorRef: JSON.stringify({
          executionID: "other-host", vendorSessionID: "other-session", [field]: sharedID,
        }),
        boundaryRef: { executionID: "other-host", vendorSessionID: "other-session", [field]: sharedID },
      })
      const unchanged = structuredClone(duplicate)
      expect(hostRecoveryContext(duplicate, reference, "opencode", fixedPolicyID)).toBeUndefined()
      expect(duplicate).toEqual(unchanged)
    }

    const malformedOtherReference = structuredClone(state)
    malformedOtherReference.executions.push({
      ...malformedOtherReference.executions[0]!, executionId: "malformed-host", vendorRef: "not-json",
    })
    expect(hostRecoveryContext(malformedOtherReference, reference, "opencode", fixedPolicyID)).toBeUndefined()

    const mismatchedOtherBoundary = structuredClone(state)
    const otherReference = { ...reference, executionID: "other-host", vendorSessionID: "other-session" }
    mismatchedOtherBoundary.executions.push({
      ...mismatchedOtherBoundary.executions[0]!, executionId: "other-host",
      vendorRef: JSON.stringify(otherReference),
      boundaryRef: { ...otherReference, vendorTurnID: "different-turn" },
    })
    expect(hostRecoveryContext(mismatchedOtherBoundary, reference, "opencode", fixedPolicyID)).toBeUndefined()

    for (const partial of ["execution-only", "vendor-only", "boundary-only"] as const) {
      const invalidReference = structuredClone(state)
      const record = invalidReference.executions[0]!
      const persisted = partial === "execution-only"
        ? { executionID: "host" }
        : { executionID: "host", vendorSessionID: "session-host" }
      if (partial !== "boundary-only") record.vendorRef = JSON.stringify(persisted)
      else delete record.vendorRef
      if (partial !== "vendor-only") record.boundaryRef = persisted
      else delete record.boundaryRef
      const unchanged = structuredClone(invalidReference)
      expect(hostRecoveryContext(invalidReference, reference, "opencode", fixedPolicyID)).toBeUndefined()
      expect(invalidReference).toEqual(unchanged)
    }

    let policyLookups = 0
    const foreignEngine = structuredClone(state)
    foreignEngine.executions[0]!.engine = "other-engine"
    expect(hostRecoveryContext(foreignEngine, reference, "opencode", () => {
      policyLookups++
      return "fixture-fixed-policy"
    })).toBeUndefined()
    expect(policyLookups).toBe(0)
    expect(hostRecoveryContext(state, reference, "", fixedPolicyID)).toBeUndefined()
    expect(hostRecoveryContext(state, reference, "x".repeat(513), fixedPolicyID)).toBeUndefined()
  } finally { f.cleanup() }
})

test("generic host recovery context refuses verifier records", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("owner", "instance", process.pid)
    f.store.registerIntent(claim, verifierIntent(claim, "verify"))
    f.store.bindVerifierRef(claim, "verify", verifierRef("verify", "legacy-unowned"))
    expect(hostRecoveryContext(f.store.status(), { executionID: "verify" }, "opencode", () => "fixture-fixed-policy"))
      .toBeUndefined()
  } finally { f.cleanup() }
})

test("host dispatch marker accepts a cleanly unbound record and remains durable and monotonic", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    f.store.registerIntent(c, intent(c, "host"))
    const before = readFileSync(path)
    expect(() => f.store.registerIntent(c, { ...intent(c, "injected"), hostDispatch: "started" } as any)).toThrow(TypeError)
    expect(readFileSync(path)).toEqual(before)
    f.store.markHostDispatched(c, "host")
    expect(f.store.status().executions[0]?.hostDispatch).toBe("started")
    expect(f.store.status().executions[0]).not.toHaveProperty("vendorRef")
    expect(f.store.status().executions[0]).not.toHaveProperty("boundaryRef")
    expect(createExecutionRunStore(f.worktree).status().executions[0]?.hostDispatch).toBe("started")
    expect(JSON.parse(readFileSync(path, "utf8")).executions[0].hostDispatch).toBe("started")

    const reference = { executionID: "host", vendorSessionID: "late-session" }
    f.store.bindVendorRef(c, "host", JSON.stringify(reference))
    expect(f.store.status().executions[0]).toMatchObject({ vendorRef: JSON.stringify(reference), boundaryRef: reference })

    const started = readFileSync(path)
    expect(() => f.store.markHostDispatched(c, "host")).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(started)
    f.store.bindVendorRef(c, "host", JSON.stringify(reference))
    expect(readFileSync(path)).toEqual(started)
    expect(() => f.store.bindVendorRef(c, "host", JSON.stringify({
      ...reference, vendorThreadID: "late-enrichment",
    }))).toThrow(TypeError)
    expect(readFileSync(path)).toEqual(started)
  } finally { f.cleanup() }
})

test("host dispatch rejects verifier records and invalid bound references", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "verify"))
    f.store.bindVerifierRef(c, "verify", verifierRef("verify", "legacy-unowned"))
    const path = join(f.executionDirectory, "state.json")
    const beforeVerifier = readFileSync(path)
    expect(() => f.store.markHostDispatched(c, "verify")).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(beforeVerifier)
  } finally { f.cleanup() }

  const g = fixture()
  try {
    const c = g.store.claim("session", "instance", process.pid)
    const path = join(g.executionDirectory, "state.json")
    g.store.registerIntent(c, intent(c, "host"))
    g.store.bindVendorRef(c, "host", JSON.stringify({ executionID: "host", vendorSessionID: "session-host" }))
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.executions[0].vendorRef = "not-json"
    writeFileSync(path, JSON.stringify(state))
    const beforeInvalidDispatch = readFileSync(path)
    expect(() => g.store.markHostDispatched(c, "host")).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(beforeInvalidDispatch)
  } finally { g.cleanup() }

  for (const partial of ["execution-only", "vendor-only", "boundary-only"] as const) {
    const h = fixture()
    try {
      const c = h.store.claim("session", "instance", process.pid)
      const path = join(h.executionDirectory, "state.json")
      h.store.registerIntent(c, intent(c, "host"))
      const state = JSON.parse(readFileSync(path, "utf8"))
      const reference = partial === "execution-only"
        ? { executionID: "host" }
        : { executionID: "host", vendorSessionID: "session-host" }
      if (partial !== "boundary-only") state.executions[0].vendorRef = JSON.stringify(reference)
      if (partial !== "vendor-only") state.executions[0].boundaryRef = reference
      writeFileSync(path, JSON.stringify(state))
      const before = readFileSync(path)
      expect(() => h.store.markHostDispatched(c, "host")).toThrow(ExecutionRunUnresolvedError)
      expect(readFileSync(path)).toEqual(before)
    } finally { h.cleanup() }
  }
})

test("host dispatch refuses cancellation, fence, terminal, or reconciliation records", () => {
  for (const blockedBy of ["cancel", "fence", "terminal", "reconciliation"] as const) {
    const f = fixture()
    try {
      const c = f.store.claim("session", "instance", process.pid)
      f.store.registerIntent(c, intent(c, "host"))
      f.store.bindVendorRef(c, "host", JSON.stringify({ executionID: "host", vendorSessionID: "session-host" }))
      if (blockedBy === "cancel") f.store.recordCancel(c, "host", { requestedAt: 1 })
      else if (blockedBy === "fence") f.store.fence(c, "host", "test fence")
      else if (blockedBy === "terminal") f.store.recordTerminal(c, "host", { outcome: "completed", terminalAt: 1 })
      else f.store.reconcile(c, "host", { outcome: "unknown", quiescent: false, evidence: "no observation" })
      const path = join(f.executionDirectory, "state.json")
      const before = readFileSync(path)
      expect(() => f.store.markHostDispatched(c, "host")).toThrow(ExecutionRunUnresolvedError)
      expect(readFileSync(path)).toEqual(before)
    } finally { f.cleanup() }
  }
})

test("host dispatch requires a current claim and matching record generation and owner", () => {
  const f = fixture()
  try {
    const old = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(old, intent(old, "host"))
    f.store.bindVendorRef(old, "host", JSON.stringify({ executionID: "host", vendorSessionID: "session-host" }))
    const path = join(f.executionDirectory, "state.json")
    f.store.recordTerminal(old, "host", { outcome: "completed", terminalAt: 1, quiescentAt: 2 })
    f.store.release(old)
    const current = f.store.claim("session-2", "instance-2", process.pid)
    const beforeStaleClaim = readFileSync(path)
    expect(() => f.store.markHostDispatched(old, "host")).toThrow(ExecutionRunBusyError)
    expect(readFileSync(path)).toEqual(beforeStaleClaim)
    expect(() => f.store.markHostDispatched(current, "host")).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(beforeStaleClaim)
  } finally { f.cleanup() }

  const g = fixture()
  try {
    const c = g.store.claim("session", "instance", process.pid)
    g.store.registerIntent(c, intent(c, "host"))
    g.store.bindVendorRef(c, "host", JSON.stringify({ executionID: "host", vendorSessionID: "session-host" }))
    const path = join(g.executionDirectory, "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.executions[0].ownerSession = "different-owner"
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path)
    expect(() => g.store.markHostDispatched(c, "host")).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(before)
  } finally { g.cleanup() }
})

test("old host records without a dispatch marker remain unresolved", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "old-host"))
    f.store.recordTerminal(c, "old-host", { outcome: "completed", terminalAt: 1 })
    const path = join(f.executionDirectory, "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    delete state.executions[0].hostDispatch
    writeFileSync(path, JSON.stringify(state))

    const record = f.store.status().executions[0]!
    expect(record.hostDispatch).toBeUndefined()
    expect(settled(record)).toBe(false)
    expect(() => f.store.registerIntent(c, intent(c, "next"))).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("host dispatch durable field accepts only the host started marker", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "host"))
    const path = join(f.executionDirectory, "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.executions[0].hostDispatch = "prepared"
    writeFileSync(path, JSON.stringify(state))
    expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
  } finally { f.cleanup() }
})

test("a shell tool latches descendant risk before execution and cannot be marked quiescent", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "e1"))
    f.store.bindVendorRef(c, "e1", JSON.stringify({ executionID: "e1", vendorSessionID: "child" }))
    const path = join(f.executionDirectory, "state.json")
    const before = readFileSync(path)
    expect(() => f.store.markProcessRiskBySession("child", "other-engine")).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(before)
    f.store.markProcessRiskBySession("child", "opencode")
    expect(f.store.status().executions[0]?.processRisk?.tool).toBe("bash")
    expect(() => f.store.recordTerminal(c, "e1", { outcome: "completed", terminalAt: 1, quiescentAt: 2 })).toThrow(ExecutionRunUnresolvedError)
    f.store.recordTerminal(c, "e1", { outcome: "completed", terminalAt: 1 })
    expect(() => f.store.reconcile(c, "e1", { outcome: "terminal", quiescent: true, evidence: "prompt returned" })).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("a shell tool cannot mark risk through a vendor reference that differs from its boundary", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("session", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    f.store.registerIntent(claim, intent(claim, "e1"))
    f.store.bindVendorRef(claim, "e1", JSON.stringify({ executionID: "e1", vendorSessionID: "child" }))
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      executions: Array<{ executionId: string; boundaryRef?: unknown }>
    }
    state.executions[0]!.boundaryRef = { executionID: "e1", vendorSessionID: "unbound-child" }
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path)

    expect(() => f.store.markProcessRiskBySession("child", "opencode")).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(before)
    expect(f.store.status().executions[0]?.processRisk).toBeUndefined()
  } finally { f.cleanup() }
})

test("linux host cannot settle from a terminal timestamp or host reconciliation boolean", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, { ...intent(c, "linux-host"), profile: "linux-single-use" })
    f.store.bindVendorRef(c, "linux-host", JSON.stringify({ executionID: "linux-host", vendorSessionID: "child" }))
    expect(() => f.store.recordTerminal(c, "linux-host", { outcome: "completed", terminalAt: 1, quiescentAt: 2 })).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.reconcile(c, "linux-host", { outcome: "terminal", quiescent: true, evidence: "vendor reports stopped" })).toThrow(ExecutionRunUnresolvedError)
    f.store.recordTerminal(c, "linux-host", { outcome: "completed", terminalAt: 1 })
    f.store.reconcile(c, "linux-host", { outcome: "terminal", quiescent: false, evidence: "vendor reports stopped" })
    expect(strictQuiescent(f.store.status().executions[0]!)).toBe(false)
    expect(settled(f.store.status().executions[0]!)).toBe(false)
    expect(() => f.store.registerIntent(c, intent(c, "next"))).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
    // Previously persisted timestamps also cannot confer retirement after restart.
    const path = join(f.executionDirectory, "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.executions[0].terminal.quiescentAt = 2
    state.executions[0].reconciliation.quiescent = true
    writeFileSync(path, JSON.stringify(state))
    expect(strictQuiescent(f.store.status().executions[0]!)).toBe(false)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("dead owner claims refuse acquisition without changing persisted state", () => {
  const f = fixture()
  try {
    const c = f.store.claim("dead-owner", "dead-instance", 2_147_483_647)
    const path = join(f.executionDirectory, "state.json")
    const before = readFileSync(path)
    expect(() => f.store.claim("next", "instance-2", process.pid)).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(before)
    expect(f.store.status()).toMatchObject({ generation: c.generation, claim: { pid: 2_147_483_647 } })
  } finally { f.cleanup() }
})

test("status is read-only and corrupt state fails closed", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    const before = f.store.status()
    expect(f.store.status()).toEqual(before)
    writeFileSync(join(f.executionDirectory, "state.json"), "{")
    expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
    expect(() => f.store.fence(c, "missing", "x")).toThrow(ExecutionRunCorruptError)
  } finally { f.cleanup() }
})

test("malformed persisted claims, records, and quiescence fail closed", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "e1"))
    const path = join(f.executionDirectory, "state.json")
    const original = JSON.parse(readFileSync(path, "utf8"))
    const corruptions = [
      (s: any) => { s.claim = { ownerSession: "session", generation: 1 } },
      (s: any) => { s.claim.token = null },
      (s: any) => { s.claim.generation = 99 },
      (s: any) => { s.executions[0].executionId = null },
      (s: any) => { s.executions[0].cancel = { acknowledgedAt: 1 } },
      (s: any) => { s.executions[0].terminal = { outcome: "done", quiescentAt: "yes" } },
      (s: any) => { s.executions[0].reconciliation = { outcome: "unknown", quiescent: true, evidence: "spoof", at: 1 } },
      (s: any) => { s.executions[0].reconciliation = { outcome: "terminal", quiescent: "true", evidence: "spoof", at: 1 } },
    ]
    for (const corrupt of corruptions) {
      const state = structuredClone(original)
      corrupt(state)
      writeFileSync(path, JSON.stringify(state))
      expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
      expect(() => f.store.assertQuiescent(c)).toThrow(ExecutionRunCorruptError)
    }
  } finally { f.cleanup() }
})

test("legacy empty directory lock cannot steal a paused owner", () => {
  const f = fixture()
  try {
    mkdirSync(f.executionDirectory, { recursive: true })
    mkdirSync(join(f.executionDirectory, "claim.lock"))
    expect(() => f.store.claim("session", "instance", process.pid)).toThrow(ExecutionRunBusyError)
  } finally { f.cleanup() }
})

test("arbitrary stale locks are retained without PID probes", () => {
  const f = fixture()
  const kill = spyOn(process, "kill")
  try {
    const dir = f.executionDirectory
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, "claim.lock")
    const identity = JSON.stringify({ pid: 2_147_483_647, token: "unknown-dead-owner" })
    symlinkSync(identity, lock)
    expect(() => f.store.claim("owner", "instance", process.pid)).toThrow(ExecutionRunBusyError)
    expect(readlinkSync(lock)).toBe(identity)
    expect(kill).not.toHaveBeenCalled()
  } finally {
    kill.mockRestore()
    f.cleanup()
  }
})

test("live owner prevents a concurrent claim", () => {
  const f = fixture()
  try {
    f.store.claim("one", "instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    const before = readFileSync(path)
    expect(() => f.store.claim("two", "instance", process.pid)).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(before)
  } finally { f.cleanup() }
})

test("matching owner cannot reacquire its persisted claim", () => {
  const f = fixture()
  try {
    const first = f.store.claim("same-session", "same-instance", process.pid)
    const path = join(f.executionDirectory, "state.json")
    const before = readFileSync(path)
    expect(() => f.store.claim("same-session", "same-instance", process.pid)).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(before)
    expect(f.store.status()).toMatchObject({ generation: first.generation, claim: { ownerSession: first.ownerSession, instance: first.instance, pid: first.pid } })
  } finally { f.cleanup() }
})

test("worktree symlink aliases share the same exclusive execution authority", () => {
  const f = fixture()
  try {
    const alias = join(f.home, "worktree-alias")
    symlinkSync(f.worktree, alias, "dir")
    expect(executionRunDirectory(alias)).toBe(f.executionDirectory)

    const claim = f.store.claim("owner", "instance", process.pid)
    const aliasStore = createExecutionRunStore(alias)
    expect(aliasStore.status().claim).toMatchObject({
      ownerSession: claim.ownerSession, instance: claim.instance, pid: claim.pid, generation: claim.generation,
    })
    expect(() => aliasStore.claim("owner", "instance", process.pid)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("a mutation preserves a replacement lock instead of releasing unknown ownership", () => {
  const f = fixture()
  try {
    const claim = f.store.claim("session", "instance", process.pid)
    const dir = f.executionDirectory
    const lock = join(dir, "claim.lock")
    const replacement = "replacement-owner-identity"
    const value: any = intent(claim, "e1")
    Object.defineProperty(value, "executionId", {
      enumerable: true,
      get() {
        unlinkSync(lock)
        symlinkSync(replacement, lock)
        return "e1"
      },
    })
    expect(() => f.store.registerIntent(claim, value)).toThrow(ExecutionRunBusyError)
    expect(readlinkSync(lock)).toBe(replacement)
    expect(f.store.status().executions.map(execution => execution.executionId)).toEqual(["e1"])
  } finally { f.cleanup() }
})

test("unresolved intent blocks another; terminal and quiescent execution permits next intent", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "e1"))
    expect(() => f.store.registerIntent(c, intent(c, "e2"))).toThrow(ExecutionRunUnresolvedError)
    f.store.recordTerminal(c, "e1", { outcome: "completed", terminalAt: 10, quiescentAt: 11 })
    f.store.registerIntent(c, intent(c, "e2"))
    expect(f.store.status().executions.map(({ executionId }) => executionId)).toEqual(["e1", "e2"])
  } finally { f.cleanup() }
})

test("legacy verifier terminal settles with an explicit unproven descendant label, never strict quiescence", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "verify"))
    const ref = verifierRef("verify", "legacy-unowned")
    f.store.bindVerifierRef(c, "verify", ref)
    f.store.markVerifierDispatched(c, "verify")
    expect(() => f.store.registerIntent(c, intent(c, "next"))).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.recordTerminal(c, "verify", { outcome: "ok", terminalAt: 10, quiescentAt: 11 })).toThrow(TypeError)
    f.store.recordTerminal(c, "verify", { outcome: "ok", terminalAt: 10, verification: verification(ref) })
    const record = f.store.status().executions[0]!
    expect(record.descendantRisk).toBe("unproven")
    expect(record.terminal?.verification?.isolationEstablished).toBe(false)
    expect(record.terminal?.verification?.domainState).toBe("unknown")
    expect(strictQuiescent(record)).toBe(false)
    expect(settled(record)).toBe(true)
    f.store.registerIntent(c, intent(c, "next"))
    f.store.recordTerminal(c, "next", { outcome: "completed", terminalAt: 12, quiescentAt: 13 })
    f.store.release(c)
  } finally { f.cleanup() }
})

test("verifier dispatch marker is store-owned, reference-bound, and monotonic", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, { ...verifierIntent(c, "verify"), verifierDispatch: "started" } as any)
    expect(f.store.status().executions[0]?.verifierDispatch).toBe("prepared")
    expect(() => f.store.markVerifierDispatched(c, "verify")).toThrow(ExecutionRunUnresolvedError)
    const ref = verifierRef("verify", "legacy-unowned")
    f.store.bindVerifierRef(c, "verify", ref)
    f.store.markVerifierDispatched(c, "verify")
    expect(f.store.status().executions[0]?.verifierDispatch).toBe("started")
    expect(() => f.store.markVerifierDispatched(c, "verify")).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.retireUndispatchedVerifier(c, "verify")).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("verifier dispatch rejects cancellation, fences, and stale generations", () => {
  for (const blockedBy of ["cancel", "fence"] as const) {
    const f = fixture()
    try {
      const c = f.store.claim("session", "instance", process.pid)
      f.store.registerIntent(c, verifierIntent(c, "verify"))
      f.store.bindVerifierRef(c, "verify", verifierRef("verify", "legacy-unowned"))
      if (blockedBy === "cancel") f.store.recordCancel(c, "verify", { requestedAt: 1 })
      else {
        f.store.fence(c, "verify", "test fence")
        expect(() => f.store.retireUndispatchedVerifier(c, "verify")).toThrow(ExecutionRunUnresolvedError)
      }
      expect(() => f.store.markVerifierDispatched(c, "verify")).toThrow(ExecutionRunUnresolvedError)
    } finally { f.cleanup() }
  }

  const f = fixture()
  try {
    const old = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(old, verifierIntent(old, "verify"))
    f.store.bindVerifierRef(old, "verify", verifierRef("verify", "legacy-unowned"))
    const path = join(f.executionDirectory, "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.claim.pid = 2147483647
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path)
    expect(() => f.store.claim("session", "instance-2", process.pid)).toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(path)).toEqual(before)
  } finally { f.cleanup() }
})

test("prepared verifier can be durably retired without claiming it ran", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "verify"))
    f.store.recordCancel(c, "verify", { requestedAt: 1 })
    f.store.retireUndispatchedVerifier(c, "verify")
    const record = f.store.status().executions[0]!
    expect(record).toMatchObject({ verifierDispatch: "retired", terminal: { outcome: "not-dispatched" } })
    expect(strictQuiescent(record)).toBe(false)
    expect(settled(record)).toBe(true)
    f.store.registerIntent(c, verifierIntent(c, "next"))
  } finally { f.cleanup() }
})

test("running reconciliation contradicts verifier retirement and unknown cannot erase the fence", () => {
  for (const dispatched of [false, true]) {
    const f = fixture()
    try {
      const c = f.store.claim("session", "instance", process.pid)
      f.store.registerIntent(c, verifierIntent(c, "verify"))
      if (dispatched) {
        const ref = verifierRef("verify", "legacy-unowned")
        f.store.bindVerifierRef(c, "verify", ref)
        f.store.markVerifierDispatched(c, "verify")
        f.store.recordTerminal(c, "verify", { outcome: "ok", terminalAt: 1, verification: verification(ref) })
      } else f.store.retireUndispatchedVerifier(c, "verify")
      expect(settled(f.store.status().executions[0]!)).toBe(true)
      f.store.reconcile(c, "verify", { outcome: "running", quiescent: false, evidence: "still active" })
      expect(settled(f.store.status().executions[0]!)).toBe(false)
      f.store.reconcile(c, "verify", { outcome: "unknown", quiescent: false, evidence: "no fresh observation" })
      expect(settled(f.store.status().executions[0]!)).toBe(false)
      expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
      expect(() => f.store.registerIntent(c, verifierIntent(c, "next"))).toThrow(ExecutionRunUnresolvedError)
    } finally { f.cleanup() }
  }
})

test("fenced, cancelled, and timed-out legacy verifier terminals remain unresolved", () => {
  const scenarios = [
    { name: "fenced", outcome: "ok", flag: "fence" as const, result: (ref: VerificationReference) => verification(ref) },
    { name: "cancel requested before normal exit", outcome: "ok", flag: "cancel" as const, result: (ref: VerificationReference) => verification(ref) },
    { name: "cancelled", outcome: "killed", flag: "cancel" as const, result: (ref: VerificationReference) => ({ ...verification(ref), cancelled: true }) },
    { name: "timed out", outcome: "timeout", flag: "none" as const, result: (ref: VerificationReference) => ({ ...verification(ref), timedOut: true }) },
    { name: "negative exit", outcome: "fail", flag: "none" as const, result: (ref: VerificationReference) => ({ ...verification(ref), parentExit: -9 }) },
  ]
  for (const scenario of scenarios) {
    const f = fixture()
    try {
      const c = f.store.claim("session", "instance", process.pid)
      f.store.registerIntent(c, verifierIntent(c, scenario.name))
      const ref = verifierRef(scenario.name, "legacy-unowned")
      f.store.bindVerifierRef(c, scenario.name, ref)
      f.store.markVerifierDispatched(c, scenario.name)
      if (scenario.flag === "fence") f.store.fence(c, scenario.name, "ambiguous verifier")
      if (scenario.flag === "cancel") f.store.recordCancel(c, scenario.name, { requestedAt: 1 })
      f.store.recordTerminal(c, scenario.name, { outcome: scenario.outcome, terminalAt: 2, verification: scenario.result(ref) })
      expect(settled(f.store.status().executions[0]!)).toBe(false)
      expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
    } finally { f.cleanup() }
  }
})

test("legacy verifier terminal must match exit classification and cannot be overwritten", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "verify"))
    const ref = verifierRef("verify", "legacy-unowned")
    f.store.bindVerifierRef(c, "verify", ref)
    f.store.markVerifierDispatched(c, "verify")
    expect(() => f.store.recordTerminal(c, "verify", {
      outcome: "fail", terminalAt: 1, verification: { ...verification(ref), parentExit: null },
    })).toThrow(TypeError)
    expect(() => f.store.recordTerminal(c, "verify", {
      outcome: "fail", terminalAt: 1, verification: verification(ref),
    })).toThrow(TypeError)
    for (const flags of [{ timedOut: true }, { cancelled: true }]) {
      expect(() => f.store.recordTerminal(c, "verify", {
        outcome: "ok", terminalAt: 1, verification: { ...verification(ref), ...flags },
      })).toThrow(TypeError)
    }
    const success = { outcome: "ok", terminalAt: 2, verification: verification(ref) }
    f.store.recordTerminal(c, "verify", success)
    f.store.recordTerminal(c, "verify", success)
    expect(() => f.store.recordTerminal(c, "verify", {
      outcome: "fail", terminalAt: 3, verification: { ...verification(ref), parentExit: 1 },
    })).toThrow(ExecutionRunUnresolvedError)
    expect(settled(f.store.status().executions[0]!)).toBe(true)
  } finally { f.cleanup() }
})

test("normal nonzero legacy parent exit is settled as a retryable failure", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "verify"))
    const ref = verifierRef("verify", "legacy-unowned")
    f.store.bindVerifierRef(c, "verify", ref)
    f.store.markVerifierDispatched(c, "verify")
    f.store.recordTerminal(c, "verify", { outcome: "fail", terminalAt: 10, verification: { ...verification(ref), parentExit: 7 } })
    expect(settled(f.store.status().executions[0]!)).toBe(true)
    f.store.registerIntent(c, verifierIntent(c, "retry"))
  } finally { f.cleanup() }
})

test("unknown legacy verifier terminal remains unresolved", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "legacy"))
    const legacyRef = verifierRef("legacy", "legacy-unowned")
    f.store.bindVerifierRef(c, "legacy", legacyRef)
    f.store.markVerifierDispatched(c, "legacy")
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
    f.store.recordTerminal(c, "legacy", {
      outcome: "unknown", terminalAt: 10, verification: { ...verification(legacyRef), parentExit: null },
    })
    expect(settled(f.store.status().executions[0]!)).toBe(false)
    expect(() => f.store.registerIntent(c, verifierIntent(c, "next"))).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("an old normal legacy terminal without lifecycle metadata is not auto-adopted", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "legacy"))
    const ref = verifierRef("legacy", "legacy-unowned")
    f.store.bindVerifierRef(c, "legacy", ref)
    f.store.markVerifierDispatched(c, "legacy")
    f.store.recordTerminal(c, "legacy", { outcome: "ok", terminalAt: 10, verification: verification(ref) })
    const path = join(f.executionDirectory, "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    delete state.executions[0].verifierDispatch
    writeFileSync(path, JSON.stringify(state))
    expect(settled(f.store.status().executions[0]!)).toBe(false)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("matching Linux reference and evidence text cannot mint native retirement authority", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "linux", "linux-single-use"))
    const ref = verifierRef("linux", "linux-single-use")
    const oldNativeReference = { ...ref, cgroupInode: "123" }
    expect(() => f.store.bindVerifierRef(c, "linux", oldNativeReference)).toThrow(TypeError)
    f.store.bindVerifierRef(c, "linux", ref)
    f.store.markVerifierDispatched(c, "linux")
    expect(() => f.store.recordTerminal(c, "linux", { outcome: "ok", terminalAt: 11, quiescentAt: 12, verification: verification(verifierRef("other", "linux-single-use")) })).toThrow(TypeError)
    f.store.recordTerminal(c, "linux", { outcome: "ok", terminalAt: 11, verification: verification(ref) })
    expect(strictQuiescent(f.store.status().executions[0]!)).toBe(false)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.reconcile(c, "linux", {
      outcome: "terminal", quiescent: true, evidence: "test boundary",
      verification: verification(verifierRef("other", "linux-single-use")),
    })).toThrow(TypeError)
    const path = join(f.executionDirectory, "state.json")
    const before = readFileSync(path)
    expect(() => f.store.reconcile(c, "linux", {
      outcome: "terminal", quiescent: true, evidence: "test boundary", verification: verification(ref),
    })).toThrow(TypeError)
    expect(readFileSync(path)).toEqual(before)
    expect(strictQuiescent(f.store.status().executions[0]!)).toBe(false)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.registerIntent(c, intent(c, "next"))).toThrow(ExecutionRunUnresolvedError)
    const forged = JSON.parse(before.toString())
    forged.executions[0].terminal.quiescentAt = 12
    writeFileSync(path, JSON.stringify(forged))
    const forgedBytes = readFileSync(path)
    expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
    expect(readFileSync(path)).toEqual(forgedBytes)
  } finally { f.cleanup() }
})

test("unit characterization only, not native Linux proof: a Linux verifier record is rejected after a boot change", async () => {
  const f = fixture()
  try {
    const runStateModule = new URL("../src/hosts/run-state.ts", import.meta.url).href
    const linuxDomainModule = fileURLToPath(new URL("../src/hosts/linux-domain.ts", import.meta.url))
    const stateStoreModule = new URL("../src/state/store.ts", import.meta.url).href
    const script = `import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
let mockedBoot = "boot-A";
mock.module(${JSON.stringify(linuxDomainModule)}, () => ({
  authenticateLinuxVerification(result, reference) {
    return reference?.bootID === mockedBoot && result?.profile === "linux-single-use" &&
      result?.isolationEstablished === true && result?.domainState === "empty" &&
      result?.proof?.reference?.bootID === mockedBoot;
  },
}));
const { createExecutionRunStore, ExecutionRunCorruptError, settled } = await import(${JSON.stringify(runStateModule)});
const { executionRunDirectory } = await import(${JSON.stringify(stateStoreModule)});
const worktree = process.env.RUN_STATE_WORKTREE;
const store = createExecutionRunStore(worktree);
const claim = store.claim("session", "instance", process.pid);
const executionID = "linux-verifier-boot-change";
const input = { inputSnapshotID: "snapshot-1", inputDigest: "a".repeat(64), deadlineAt: Date.now() + 60000, maxOutputChars: 4000 };
store.registerIntent(claim, {
  executionId: executionID, ownerSession: claim.ownerSession, taskId: "task", attemptId: "attempt",
  generation: claim.generation, role: "worker", cwd: "/tmp", policyID: "fixture-fixed-policy",
  kind: "verifier", profile: "linux-single-use", ...input,
});
const reference = {
  kind: "verifier", executionID, profile: "linux-single-use", invocationID: "invocation-boot-change",
  ...input, unit: "lca-verifier.service", bootID: "boot-A",
};
const result = {
  profile: "linux-single-use", parentExit: 0, timedOut: false, cancelled: false,
  isolationEstablished: true, domainState: "empty", integrity: "unchanged", output: "ok",
  proof: { reference, evidence: "test-contained authenticator fixture" },
};
store.bindVerifierRef(claim, executionID, reference);
store.markVerifierDispatched(claim, executionID);
store.recordTerminal(claim, executionID, {
  outcome: "ok", terminalAt: Date.now(), quiescentAt: Date.now(), verification: result,
});
const accepted = store.status().executions[0];
const settledUnderBootA = settled(accepted);
store.assertQuiescent(claim);
store.release(claim);
const path = join(executionRunDirectory(worktree), "state.json");
const releasedUnderBootA = !store.status().claim;
const before = readFileSync(path);
const settledRecord = JSON.parse(before.toString("utf8")).executions[0];
mockedBoot = "boot-B";
const settledUnderBootB = settled(settledRecord);
const capture = action => {
  try { action(); return { threw: false, exact: false, name: "none" }; }
  catch (error) {
    return {
      threw: true,
      exact: error instanceof ExecutionRunCorruptError,
      name: error?.constructor?.name ?? "unknown",
    };
  }
};
const readFailure = capture(() => store.status());
const settleFailure = capture(() => store.assertQuiescent(claim));
const releaseFailure = capture(() => store.release(claim));
console.log(JSON.stringify({
  settledUnderBootA, releasedUnderBootA,
  settledUnderBootB, readFailure, settleFailure, releaseFailure,
  bytesUnchanged: readFileSync(path).equals(before),
}));`
    const env = {
      PATH: process.env.PATH ?? "", HOME: join(f.home, "child-home"),
      XDG_STATE_HOME: join(f.home, "child-xdg"), LCA_STATE_HOME: join(f.home, "child-lca"),
      RUN_STATE_WORKTREE: f.worktree,
    }
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as {
      settledUnderBootA: boolean
      releasedUnderBootA: boolean
      settledUnderBootB: boolean
      readFailure: { threw: boolean; exact: boolean; name: string }
      settleFailure: { threw: boolean; exact: boolean; name: string }
      releaseFailure: { threw: boolean; exact: boolean; name: string }
      bytesUnchanged: boolean
    }
    expect(result).toEqual({
      settledUnderBootA: true,
      releasedUnderBootA: true,
      settledUnderBootB: false,
      readFailure: { threw: true, exact: true, name: "ExecutionRunCorruptError" },
      settleFailure: { threw: true, exact: true, name: "ExecutionRunCorruptError" },
      releaseFailure: { threw: true, exact: true, name: "ExecutionRunCorruptError" },
      bytesUnchanged: true,
    })
  } finally { f.cleanup() }
})

test("old untyped records remain readable but cannot release even with historical quiescence", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    const { kind, profile, ...oldIntent } = intent(c, "old")
    expect(() => f.store.registerIntent(c, oldIntent)).toThrow(TypeError)
    const path = join(f.executionDirectory, "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.executions.push({ ...oldIntent, terminal: { outcome: "completed", terminalAt: 1, quiescentAt: 2 } })
    writeFileSync(path, JSON.stringify(state))
    expect(f.store.status().executions[0]?.kind).toBeUndefined()
    expect(() => f.store.registerIntent(c, intent(c, "new"))).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("verifier reference cannot own host Bash risk and malformed durable fields fail closed", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "verify"))
    const ref = verifierRef("verify", "legacy-unowned")
    f.store.bindVerifierRef(c, "verify", ref)
    expect(() => f.store.bindVendorRef(c, "verify", JSON.stringify({ executionID: "verify", vendorSessionID: "child" }))).toThrow(TypeError)
    expect(() => f.store.markProcessRiskBySession("child", "opencode")).toThrow(ExecutionRunUnresolvedError)
    const path = join(f.executionDirectory, "state.json")
    const original = JSON.parse(readFileSync(path, "utf8"))
    const corruptions = [
      (s: any) => { s.executions[0].profile = "unknown" },
      (s: any) => { s.executions[0].hostDispatch = "started" },
      (s: any) => { s.executions[0].descendantRisk = "none" },
      (s: any) => { s.executions[0].boundaryRef.executionID = "other" },
      (s: any) => { s.executions[0].boundaryRef.inputDigest = "b".repeat(64) },
      (s: any) => { s.executions[0].maxOutputChars = -1 },
      (s: any) => { s.executions[0].processRisk = { tool: "bash", at: 1 } },
      (s: any) => { s.executions[0].terminal = { outcome: "completed", terminalAt: 1 } },
      (s: any) => { s.executions[0].terminal = { outcome: "ok", terminalAt: 1, verification: { ...verification(ref), isolationEstablished: true } } },
    ]
    for (const corrupt of corruptions) {
      const state = structuredClone(original)
      corrupt(state)
      writeFileSync(path, JSON.stringify(state))
      expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
    }
  } finally { f.cleanup() }
})

test("independent processes cannot both acquire the initial claim", async () => {
  const f = fixture()
  try {
    const moduleUrl = new URL("../src/hosts/run-state.ts", import.meta.url).href
    const script = `import { createExecutionRunStore } from ${JSON.stringify(moduleUrl)};
const store = createExecutionRunStore(process.env.RUN_STATE_WORKTREE);
try { store.claim("owner-" + process.pid, "instance-" + process.pid, process.pid); console.log("acquired:" + process.pid); await new Promise(r => setTimeout(r, 150)); }
catch { console.log("refused:" + process.pid); }`
    const children = [0, 1].map(index => {
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: join(f.home, `child-home-${index}`),
        XDG_STATE_HOME: join(f.home, `child-xdg-${index}`),
        LCA_STATE_HOME: join(f.home, `child-lca-${index}`),
        RUN_STATE_WORKTREE: f.worktree,
      }
      return Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" })
    })
    const results = await Promise.all(children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      return stdout.trim()
    }))
    const acquired = results.filter(result => result.startsWith("acquired:"))
    const refused = results.filter(result => result.startsWith("refused:"))
    expect(acquired).toHaveLength(1)
    expect(refused).toHaveLength(1)
    const acquiredPid = Number(acquired[0]!.slice("acquired:".length))
    expect(Number.isSafeInteger(acquiredPid)).toBe(true)
    expect(f.store.status().claim).toMatchObject({
      ownerSession: `owner-${acquiredPid}`, instance: `instance-${acquiredPid}`, pid: acquiredPid,
    })
  } finally { f.cleanup() }
})

test("persisted state symlinks are retained and never treated as absent or adopted", () => {
  for (const populated of [false, true]) {
    const f = fixture()
    try {
      const target = join(f.home, "linked-state.json")
      const contents = JSON.stringify({ generation: 41, executions: [] })
      if (populated) writeFileSync(target, contents)
      const path = join(f.executionDirectory, "state.json")
      symlinkSync(target, path)
      expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
      expect(() => f.store.claim("owner", "instance", process.pid)).toThrow(ExecutionRunCorruptError)
      expect(readlinkSync(path)).toBe(target)
      if (populated) expect(readFileSync(target, "utf8")).toBe(contents)
    } finally { f.cleanup() }
  }
})
