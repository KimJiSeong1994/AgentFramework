import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation } from "../src/hosts/types.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import type { Terminal } from "../src/hosts/interactive-session.ts"
import { inspectSessionAttachment, type SessionStore } from "../src/sessions/store.ts"
import { closeFreshSession, runNativeSkillOptLoadCanary, runNativeSkillOptRollbackCanary } from "../src/skillopt/load-execution.ts"
import { NativeLoadVerificationError } from "../src/skillopt/load-verification.ts"
import { createSkillOptController, type SkillOptNativeHost } from "../src/skillopt/controller.ts"
import { tempWorktree, type TempWorktree } from "./guards-helpers.ts"

const digest = "a".repeat(64)
const worktrees: TempWorktree[] = []
const owners: SessionStore[] = []

afterEach(() => {
  for (const owner of owners.splice(0)) {
    if (!owner.isReleased) {
      try { owner.release({ workflowQuiescent: true, evidence: "load bridge refusal test completed", workflowID: null, revision: null }) }
      catch { /* The worktree fixture owns cleanup after a refusal. */ }
    }
  }
  for (const worktree of worktrees.splice(0)) worktree.cleanup()
})

function loadCanaryFixture(options: { targetPath?: () => string } = {}) {
  const worktree = tempWorktree()
  worktrees.push(worktree)
  let prepareCalls = 0
  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) {
      prepareCalls += 1
      throw new Error("the refusal path must not call a model host")
    },
    async reconcile(): Promise<ExecutionReconciliation> {
      return { outcome: "unknown", quiescent: false, evidence: "no native canary was dispatched" }
    },
  }
  const runtime = createExecutionRuntime({ directory: worktree.worktree, worktree: worktree.worktree,
    config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, { planningOnlyMain: true })
  const owner = attachAdmission(runtime, `load_bridge_${randomUUID().replaceAll("-", "")}`, { engine: "codex", model: "codex-test" })
  owners.push(owner)
  const nativeHost: SkillOptNativeHost = {
    consumeCompletedTargetWitness() { throw new Error("no target response was dispatched") },
    consumeCompletedOptimizerWitness() { throw new Error("no optimizer response was dispatched") },
    identityFor() { return undefined },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "no native canary was dispatched" } },
  }
  const controller = createSkillOptController(runtime,
    { nativeHelperPath: join(worktree.worktree, "missing-native-helper"), nativeHelperSha256: digest }, nativeHost)
  const runId = randomUUID()
  const input = {
    controller,
    owner,
    runId,
    current: { dataset: {}, baselineSkillSha256: "b".repeat(64) },
    fixtureId: "fixture-not-reached",
    promotion: {
      get targetPath() {
        return options.targetPath ? options.targetPath() : join(worktree.worktree, ".agents/skills/llm-wiki/SKILL.md")
      },
      transactionRoot: join(worktree.worktree, ".skillopt-promotion"),
      nativeHelperPath: join(worktree.worktree, "missing-native-helper"),
      nativeHelperSha256: digest,
      bindings: {
        witnessMode: "native" as const, runId, rootBinding: digest, sourceSha256: digest, originalSha256: digest,
        candidateSha256: "b".repeat(64), fixturePackSha256: digest, canaryFixtureSha256: digest,
        protocolSha256: digest, evaluatorSha256: digest, runtimeSha256: digest, resultsSha256: digest,
        witnessSha256: digest, nativeEngine: "codex" as const, nativeModel: "codex-test", nativeProfileId: "codex-test",
        nativeProfileSha256: digest, nativeRuntimeVersion: "codex-test", nativeExecutableSha256: digest,
      },
      evidence: {
        qualification: { path: join(worktree.worktree, "missing-qualification.json"), sha256: digest },
        review: { path: join(worktree.worktree, "missing-review.json"), sha256: digest },
        approval: { path: join(worktree.worktree, "missing-approval.json"), sha256: digest },
      },
    },
    terminal: {} as Terminal,
    signal: new AbortController().signal,
  }
  return { input, runtime, prepareCalls: () => prepareCalls }
}

async function expectPreflightDiagnosticRefusal(error: Error, expectedErrorCode?: string,
  sensitiveValues: readonly string[] = []) {
  const fixture = loadCanaryFixture({ targetPath() { throw error } })
  const initialRuntimeStatus = fixture.runtime.runs.status()
  const result = await runNativeSkillOptLoadCanary(fixture.input)
  const serialized = JSON.stringify(result)

  expect(result).toMatchObject({ status: "BLOCKED", reasonCode: "canary_bridge_refused", phase: "preflight" })
  if (expectedErrorCode) expect(result.errorCode).toBe(expectedErrorCode)
  else expect(result).not.toHaveProperty("errorCode")
  expect(serialized).not.toContain(error.message)
  expect(serialized).not.toContain(JSON.stringify(error.message).slice(1, -1))
  for (const sensitiveValue of sensitiveValues) expect(serialized).not.toContain(sensitiveValue)
  expect(result).not.toHaveProperty("message")
  expect(fixture.prepareCalls()).toBe(0)
  const finalRuntimeStatus = fixture.runtime.runs.status()
  expect(finalRuntimeStatus.executions).toEqual(initialRuntimeStatus.executions)
  expect(finalRuntimeStatus.claim).toBe(initialRuntimeStatus.claim)
  expect(finalRuntimeStatus.executions).toEqual([])
  expect(finalRuntimeStatus.claim).toBeUndefined()
}

describe("native SkillOpt load execution bridge", () => {
  test("refuses a missing native promotion transaction before constructing a model execution", async () => {
    const fixture = loadCanaryFixture()
    const result = await runNativeSkillOptLoadCanary(fixture.input)

    expect(result.status).toBe("BLOCKED")
    expect(fixture.prepareCalls()).toBe(0)
    expect(fixture.runtime.runs.status().executions).toEqual([])
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
  })

  test("redacts raw preflight Error diagnostics without dispatching", async () => {
    const errorMessage = "fixture prompt=FIXTURE_RAW_PROMPT path=/fixture/raw/path token=FIXTURE_RAW_TOKEN"
    const errorCode = "fixture-raw-error-code"
    const payload = "fixture raw payload=FIXTURE_RAW_PAYLOAD"
    const error = Object.assign(new Error(errorMessage), { code: errorCode, payload })

    await expectPreflightDiagnosticRefusal(error, undefined, [errorCode, payload])
  })

  test("does not trust a plain Error spoofing a typed diagnostic name and code", async () => {
    const error = new Error("fixture prompt=FIXTURE_SPOOFED_PROMPT path=/fixture/spoofed/path token=FIXTURE_SPOOFED_TOKEN")
    const spoofedCode = "fixture-spoofed-sensitive-code"
    const payload = "fixture spoofed payload=FIXTURE_SPOOFED_PAYLOAD"
    error.name = "NativeLoadVerificationError"
    Object.assign(error, { code: spoofedCode, payload })

    await expectPreflightDiagnosticRefusal(error, undefined, [spoofedCode, payload])
  })

  test("preserves only a valid typed diagnostic code while redacting its message", async () => {
    const error = new NativeLoadVerificationError("canary-fixture-pack-invalid")
    error.message = "fixture prompt=FIXTURE_TYPED_PROMPT path=/fixture/typed/path token=FIXTURE_TYPED_TOKEN"
    const payload = "fixture typed payload=FIXTURE_TYPED_PAYLOAD"
    Object.assign(error, { payload })

    await expectPreflightDiagnosticRefusal(error, "canary-fixture-pack-invalid", [payload])
  })

  test("redacts a typed diagnostic with a multiline invalid code", async () => {
    const error = new NativeLoadVerificationError(
      "canary-fixture-pack-invalid\nfixture prompt=FIXTURE_INVALID_CODE_PROMPT path=/fixture/invalid-code/path token=FIXTURE_INVALID_CODE_TOKEN")

    await expectPreflightDiagnosticRefusal(error)
  })

  test("a rollback canary without an authentic live intent or rollback handoff performs zero dispatches", async () => {
    const worktree = tempWorktree()
    worktrees.push(worktree)
    let prepareCalls = 0
    const host: ExecutionHost = {
      identity: { engine: "codex", profile: "legacy-unowned" },
      async preflight() { return { compatible: true, controls: {}, problems: [] } },
      async prepare(_request: ExecutionRequest) {
        prepareCalls += 1
        throw new Error("a forged rollback intent must never reach a model host")
      },
      async reconcile(): Promise<ExecutionReconciliation> {
        return { outcome: "unknown", quiescent: false, evidence: "no rollback canary was dispatched" }
      },
    }
    const runtime = createExecutionRuntime({ directory: worktree.worktree, worktree: worktree.worktree,
      config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, { planningOnlyMain: true })
    const owner = attachAdmission(runtime, `rollback_bridge_${randomUUID().replaceAll("-", "")}`, { engine: "codex", model: "codex-test" })
    owners.push(owner)
    const nativeHost: SkillOptNativeHost = {
      consumeCompletedTargetWitness() { throw new Error("no target response was dispatched") },
      consumeCompletedOptimizerWitness() { throw new Error("no optimizer response was dispatched") },
      identityFor() { return undefined },
      async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "no rollback canary was dispatched" } },
    }
    const controller = createSkillOptController(runtime,
      { nativeHelperPath: join(worktree.worktree, "missing-native-helper"), nativeHelperSha256: digest }, nativeHost)
    const runId = randomUUID()
    const result = await runNativeSkillOptRollbackCanary({
      controller,
      owner,
      runId,
      current: { dataset: {}, baselineSkillSha256: "b".repeat(64) },
      fixtureId: "fixture-not-reached",
      intent: Object.freeze({}) as never,
      promotion: {
        targetPath: join(worktree.worktree, ".agents/skills/llm-wiki/SKILL.md"),
        transactionRoot: join(worktree.worktree, ".skillopt-promotion"),
        nativeHelperPath: join(worktree.worktree, "missing-native-helper"),
        nativeHelperSha256: digest,
        bindings: {
          witnessMode: "native", runId, rootBinding: digest, sourceSha256: digest, originalSha256: digest,
          candidateSha256: "b".repeat(64), fixturePackSha256: digest, canaryFixtureSha256: digest,
          protocolSha256: digest, evaluatorSha256: digest, runtimeSha256: digest, resultsSha256: digest,
          witnessSha256: digest, nativeEngine: "codex", nativeModel: "codex-test", nativeProfileId: "codex-test",
          nativeProfileSha256: digest, nativeRuntimeVersion: "codex-test", nativeExecutableSha256: digest,
        },
        evidence: {
          qualification: { path: join(worktree.worktree, "missing-qualification.json"), sha256: digest },
          review: { path: join(worktree.worktree, "missing-review.json"), sha256: digest },
          approval: { path: join(worktree.worktree, "missing-approval.json"), sha256: digest },
        },
      },
      terminal: {} as Terminal,
      signal: new AbortController().signal,
    })

    expect(result.status).toBe("UNRESOLVED")
    expect(prepareCalls).toBe(0)
    expect(runtime.runs.status().executions).toEqual([])
    expect(runtime.runs.status().claim).toBeUndefined()
  })

  test("records explicit no-dispatch evidence in the fresh session release receipt", () => {
    const worktree = tempWorktree()
    worktrees.push(worktree)
    const host: ExecutionHost = {
      identity: { engine: "codex", profile: "legacy-unowned" },
      async preflight() { return { compatible: true, controls: {}, problems: [] } },
      async prepare(_request: ExecutionRequest) { throw new Error("release recording must not dispatch") },
      async reconcile(): Promise<ExecutionReconciliation> {
        return { outcome: "unknown", quiescent: false, evidence: "no native canary was dispatched" }
      },
    }
    const runtime = createExecutionRuntime({ directory: worktree.worktree, worktree: worktree.worktree,
      config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, { planningOnlyMain: true })
    const owner = attachAdmission(runtime, `load_release_${randomUUID().replaceAll("-", "")}`, { engine: "codex", model: "codex-test" })
    owners.push(owner)

    closeFreshSession(undefined, owner, "native SkillOpt loader canary was prepared but not dispatched")

    expect(inspectSessionAttachment(worktree.worktree, owner.sessionID, owner.epoch)).toMatchObject({
      state: "released",
      releaseEvidence: "native SkillOpt loader canary was prepared but not dispatched",
    })
    expect(runtime.runs.status().executions).toEqual([])
    expect(runtime.runs.status().claim).toBeUndefined()
  })
})
