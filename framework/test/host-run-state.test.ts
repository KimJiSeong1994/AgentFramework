import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
const verifierRef = (executionID: string, profile: "legacy-unowned" | "linux-single-use"): VerificationReference => ({ kind: "verifier", executionID, profile, invocationID: `invocation-${executionID}`, ...verifierInput, ...(profile === "linux-single-use" ? { unit: `unit-${executionID}`, bootID: "boot", cgroupInode: "123" } : {}) })
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

test("unknown recovered legacy terminal settles but linux verifier needs matching strict boundary proof", () => {
  const f = fixture()
  try {
    const c = f.store.claim("session", "instance", process.pid)
    f.store.registerIntent(c, verifierIntent(c, "legacy"))
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
    f.store.recordTerminal(c, "legacy", { outcome: "unknown", terminalAt: 10 })
    f.store.registerIntent(c, verifierIntent(c, "linux", "linux-single-use"))
    const ref = verifierRef("linux", "linux-single-use")
    f.store.bindVerifierRef(c, "linux", ref)
    f.store.recordTerminal(c, "linux", { outcome: "ok", terminalAt: 11, verification: verification(ref) })
    expect(() => f.store.release(c)).toThrow(ExecutionRunUnresolvedError)
    expect(() => f.store.recordTerminal(c, "linux", { outcome: "ok", terminalAt: 11, quiescentAt: 12, verification: verification(verifierRef("other", "linux-single-use")) })).toThrow(TypeError)
    f.store.recordTerminal(c, "linux", { outcome: "ok", terminalAt: 11, quiescentAt: 12, verification: verification(ref) })
    expect(strictQuiescent(f.store.status().executions[1]!)).toBe(true)
    f.store.release(c)
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
