import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createExecutionRunStore, ExecutionRunBusyError, ExecutionRunCorruptError, ExecutionRunUnresolvedError, settled, strictQuiescent } from "../src/hosts/run-state.ts"
import type { VerificationReference, VerificationResult } from "../src/orchestration/verifier.ts"
import { stateRoot } from "../src/state/store.ts"

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "run-state-"))
  const prior = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = home
  const store = createExecutionRunStore(join(home, "worktree"))
  return { home, store, cleanup() { if (prior === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior; rmSync(home, { recursive: true, force: true }) } }
}
const intent = (claim: ReturnType<ReturnType<typeof createExecutionRunStore>["claim"]>, executionId: string) => ({ executionId, ownerSession: claim.ownerSession, taskId: "task", attemptId: "attempt", generation: claim.generation, role: "worker", cwd: "/tmp", policyID: "fixture-fixed-policy", kind: "host" as const, profile: "legacy-unowned" as const })
const verifierInput = { inputSnapshotID: "snapshot-1", inputDigest: "a".repeat(64), deadlineAt: 100000, maxOutputChars: 4000 }
const verifierIntent = (claim: ReturnType<ReturnType<typeof createExecutionRunStore>["claim"]>, executionId: string, profile: "legacy-unowned" | "linux-single-use" = "legacy-unowned") => ({ ...intent(claim, executionId), kind: "verifier" as const, profile, ...verifierInput })
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

test("a shell tool latches descendant risk before execution and cannot be marked quiescent", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "e1"))
    f.store.bindVendorRef(c, "e1", JSON.stringify({ executionID: "e1", vendorSessionID: "child" }))
    f.store.markProcessRiskBySession("child")
    expect(f.store.status().executions[0]?.processRisk?.tool).toBe("bash")
    expect(() => f.store.recordTerminal(c, "e1", { outcome: "completed", terminalAt: 1, quiescentAt: 2 })).toThrow(ExecutionRunUnresolvedError)
    f.store.recordTerminal(c, "e1", { outcome: "completed", terminalAt: 1 })
    expect(() => f.store.reconcile(c, "e1", { outcome: "terminal", quiescent: true, evidence: "prompt returned" })).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
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
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.executions[0].terminal.quiescentAt = 2
    state.executions[0].reconciliation.quiescent = true
    writeFileSync(path, JSON.stringify(state))
    expect(strictQuiescent(f.store.status().executions[0]!)).toBe(false)
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("dead owner takeover permits reconciliation but blocks new intent until quiescent", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "e1"))
    // Simulate a dead owner while retaining its unresolved execution.
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.claim.pid = 2147483647
    writeFileSync(path, JSON.stringify(state))
    const takeover = f.store.claim("next", "instance-2", process.pid)
    expect(() => f.store.registerIntent(takeover, intent(takeover, "e2"))).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.assertQuiescent(takeover)).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.release(takeover)).toThrow(ExecutionRunUnresolvedError)
    f.store.reconcile(takeover, "e1", { outcome: "terminal", quiescent: true, evidence: "reconciled stopped" })
    f.store.registerIntent(takeover, intent(takeover, "e2"))
    expect(c.pid).toBe(process.pid)
    expect(() => f.store.fence(c, "e1", "old generation")).toThrow(ExecutionRunBusyError)
  } finally { f.cleanup() }
})

test("status is read-only and corrupt state fails closed", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    const before = f.store.status()
    expect(f.store.status()).toEqual(before)
    writeFileSync(join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json"), "{")
    expect(() => f.store.status()).toThrow(ExecutionRunCorruptError)
    expect(() => f.store.fence(c, "missing", "x")).toThrow(ExecutionRunCorruptError)
  } finally { f.cleanup() }
})

test("malformed persisted claims, records, and quiescence fail closed", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, intent(c, "e1"))
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
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
    mkdirSync(join(stateRoot(join(f.home, "worktree")), "execution-runs"), { recursive: true })
    mkdirSync(join(stateRoot(join(f.home, "worktree")), "execution-runs", "claim.lock"))
    expect(() => f.store.claim("session", "instance", process.pid)).toThrow(ExecutionRunBusyError)
  } finally { f.cleanup() }
})

test("two subprocesses race to recover a lock left by a crashed owner", async () => {
  const f = fixture()
  try {
    const dir = join(stateRoot(join(f.home, "worktree")), "execution-runs")
    mkdirSync(dir, { recursive: true })
    const crashed = Bun.spawn([process.execPath, "-e", `import { symlinkSync } from "node:fs"; symlinkSync(JSON.stringify({ pid: process.pid, token: "crashed" }), process.env.RUN_STATE_LOCK); process.exit(0)`], {
      env: { PATH: process.env.PATH ?? "", RUN_STATE_LOCK: join(dir, "claim.lock") }, stdout: "pipe", stderr: "pipe",
    })
    expect(await crashed.exited).toBe(0)
    expect(await new Response(crashed.stderr).text()).toBe("")
    const moduleUrl = new URL("../src/hosts/run-state.ts", import.meta.url).href
    const script = `import { createExecutionRunStore } from ${JSON.stringify(moduleUrl)};
const store = createExecutionRunStore(process.env.RUN_STATE_WORKTREE);
try { store.claim("owner-" + process.pid, "instance-" + process.pid, process.pid); console.log("acquired"); await new Promise(r => setTimeout(r, 150)); }
catch { console.log("refused"); }`
    const env = { PATH: process.env.PATH ?? "", HOME: f.home, XDG_STATE_HOME: f.home, RUN_STATE_WORKTREE: join(f.home, "worktree") }
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }))
    const results = await Promise.all(children.map(async child => {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code).toBe(0)
      expect(err).toBe("")
      return out.trim()
    }))
    expect(results.filter(x => x === "acquired")).toHaveLength(1)
    expect(results.filter(x => x === "refused")).toHaveLength(1)
  } finally { f.cleanup() }
})

test("live owner prevents a concurrent claim", () => {
  const f = fixture()
  try {
    f.store.claim("one", "instance", process.pid)
    expect(() => f.store.claim("two", "instance", process.pid)).toThrow(ExecutionRunUnresolvedError)
  } finally { f.cleanup() }
})

test("same owner reuses its persisted claim", () => {
  const f = fixture()
  try {
    const first = f.store.claim("same-session", "same-instance", process.pid)
    const recovered = f.store.claim("same-session", "same-instance", process.pid)
    expect(recovered).toEqual(first)
    expect(recovered.generation).toBe(first.generation)
    expect(recovered.token).toBe(first.token)
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
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.claim.pid = 2147483647
    writeFileSync(path, JSON.stringify(state))
    const takeover = f.store.claim("session", "instance-2", process.pid)
    expect(() => f.store.markVerifierDispatched(takeover, "verify")).toThrow(ExecutionRunUnresolvedError)
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
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
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
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
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
const { stateRoot } = await import(${JSON.stringify(stateStoreModule)});
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
const path = join(stateRoot(worktree), "execution-runs", "state.json");
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
      PATH: process.env.PATH ?? "", HOME: f.home, XDG_STATE_HOME: f.home,
      RUN_STATE_WORKTREE: join(f.home, "worktree"),
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
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
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
    expect(() => f.store.markProcessRiskBySession("child")).toThrow(ExecutionRunUnresolvedError)
    const path = join(stateRoot(join(f.home, "worktree")), "execution-runs", "state.json")
    const original = JSON.parse(readFileSync(path, "utf8"))
    const corruptions = [
      (s: any) => { s.executions[0].profile = "unknown" },
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
try { store.claim("owner-" + process.pid, "instance-" + process.pid, process.pid); console.log("acquired"); await new Promise(r => setTimeout(r, 150)); }
catch { console.log("refused"); }`
    const env = { PATH: process.env.PATH ?? "", HOME: f.home, XDG_STATE_HOME: f.home, RUN_STATE_WORKTREE: join(f.home, "worktree") }
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }))
    const results = await Promise.all(children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      return stdout.trim()
    }))
    expect(results.filter((result) => result === "acquired")).toHaveLength(1)
    expect(results.filter((result) => result === "refused")).toHaveLength(1)
  } finally { f.cleanup() }
})
