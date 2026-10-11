import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import process from "node:process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createVendorProcess, type VendorProcessOptions } from "../src/hosts/vendor-process.ts"
import { createCLIReferenceStream, type CLIReferenceEngine, type CLIReferenceStream } from "../src/hosts/cli-reference-stream.ts"
import { createExecutionRunStore, type ExecutionRunStore } from "../src/hosts/run-state.ts"
import type { ExecutionReference } from "../src/hosts/types.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

const FIXTURE = join(import.meta.dir, "fixtures/vendor-process-child.ts")
const ROOT = resolve(import.meta.dir, "../..")
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"]
const tempDirectories: string[] = []
const executionFixtureCleanups: Array<() => void> = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  for (const cleanup of executionFixtureCleanups.splice(0)) cleanup()
})

function childArgv(mode: string, ...args: string[]): string[] {
  if (process.versions.bun) return [FIXTURE, mode, ...args]
  return ["--input-type=module", "--eval", readFileSync(FIXTURE, "utf8"), FIXTURE, mode, ...args]
}

function options(mode: string, args: string[] = [], overrides: Partial<VendorProcessOptions> = {}): VendorProcessOptions {
  return {
    executable: process.execPath,
    argv: childArgv(mode, ...args),
    cwd: ROOT,
    deadlineAt: Date.now() + 5000,
    maxCombinedOutputBytes: 4096,
    termToKillMs: 100,
    ...overrides,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function executionFixture(engine: CLIReferenceEngine, executionID: string, seedReferenceCollision = false): {
  worktree: string
  runs: ExecutionRunStore
  claim: ReturnType<ExecutionRunStore["claim"]>
  cleanup(): void
} {
  const previousStateHome = process.env.LCA_STATE_HOME
  const previousXdgStateHome = process.env.XDG_STATE_HOME
  const worktree = tempGitWorktree()
  process.env.LCA_STATE_HOME = worktree.stateHome
  const runs = createExecutionRunStore(worktree.worktree)
  const claim = runs.claim("reference-stream-test", "vendor-process-test", process.pid)
  if (seedReferenceCollision) {
    const collisionExecutionID = `${executionID}-collision`
    runs.registerIntent(claim, {
      executionId: collisionExecutionID,
      ownerSession: claim.ownerSession,
      taskId: "collision-task",
      attemptId: "collision-attempt",
      generation: claim.generation,
      role: "worker",
      cwd: worktree.worktree,
      policyID: "fixture-policy",
      kind: "host",
      engine,
      profile: "legacy-unowned",
    })
    runs.bindVendorRef(claim, collisionExecutionID, JSON.stringify(
      referenceFor(engine, collisionExecutionID, canonicalFixtureID(engine)),
    ))
    runs.markHostDispatched(claim, collisionExecutionID)
    const now = Date.now()
    runs.recordTerminal(claim, collisionExecutionID, { outcome: "completed", terminalAt: now, quiescentAt: now })
  }
  runs.registerIntent(claim, {
    executionId: executionID,
    ownerSession: claim.ownerSession,
    taskId: "reference-task",
    attemptId: "reference-attempt",
    generation: claim.generation,
    role: "worker",
    cwd: worktree.worktree,
    policyID: "fixture-policy",
    kind: "host",
    engine,
    profile: "legacy-unowned",
  })
  runs.markHostDispatched(claim, executionID)
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    try {
      worktree.cleanup()
    } finally {
      if (previousStateHome === undefined) delete process.env.LCA_STATE_HOME
      else process.env.LCA_STATE_HOME = previousStateHome
      if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousXdgStateHome
    }
  }
  executionFixtureCleanups.push(cleanup)
  return { worktree: worktree.worktree, runs, claim, cleanup }
}

function canonicalFixtureID(engine: CLIReferenceEngine): string {
  return engine === "claude-code" ? "claude-fixture-session" : "codex-fixture-thread"
}

function referenceFor(engine: CLIReferenceEngine, executionID: string, id: string) {
  return engine === "claude-code"
    ? { executionID, vendorSessionID: id }
    : { executionID, vendorThreadID: id }
}

test("CLI reference decoder handles documented Claude frames and UTF-8 splits incrementally", () => {
  const references: unknown[] = []
  const stream = createCLIReferenceStream({
    engine: "claude-code",
    executionID: "claude-execution",
    onReference(reference) { references.push(reference); return undefined },
  })
  const frames = [
    '{"type":"system","subtype":"plugin_install","status":"started","session_id":"session-雪"}\n',
    '{"type":"assistant","session_id":"session-雪","message":{"session_id":"nested-decoy"}}\n',
    '{"type":"system","subtype":"init","session_id":"session-雪","turn_id":"optional-turn"}\n',
    '{"type":"system","subtype":"init","session_id":"session-雪"}\n',
  ]
  const bytes = Buffer.from(frames.join(""))
  const split = bytes.indexOf(Buffer.from("雪")) + 1
  stream.onStdoutChunk(bytes.subarray(0, split))
  stream.onStdoutChunk(bytes.subarray(split, split + 1))
  stream.onStdoutChunk(bytes.subarray(split + 1))
  stream.finish()

  expect(references).toEqual([{ executionID: "claude-execution", vendorSessionID: "session-雪" }])
})

test("CLI reference decoder reads only the top-level Codex thread.started identity", () => {
  const references: unknown[] = []
  const stream = createCLIReferenceStream({
    engine: "codex",
    executionID: "codex-execution",
    onReference(reference) { references.push(reference); return undefined },
  })
  const frames = [
    '{"type":"item.completed","item":{"thread_id":"nested-decoy"}}\n',
    '{"type":"thread.started","thread_id":"thread-fixture"}\n',
    '{"type":"thread.started","thread_id":"thread-fixture"}\n',
  ]
  const bytes = Buffer.from(frames.join(""))
  for (let offset = 0; offset < bytes.length;) {
    const end = Math.min(bytes.length, offset + 7)
    stream.onStdoutChunk(bytes.subarray(offset, end))
    offset = end
  }
  stream.finish()

  expect(references).toEqual([{ executionID: "codex-execution", vendorThreadID: "thread-fixture" }])
})

for (const engine of ["claude-code", "codex"] as const) {
  test.each(["empty", "identity-free"] as const)(`${engine} EOF refuses a %s stream without a bound identity`, kind => {
    let calls = 0
    const stream = createCLIReferenceStream({
      engine, executionID: "missing-stream-identity",
      onReference() { calls++; return undefined },
    })
    if (kind === "identity-free") {
      stream.onStdoutChunk(Buffer.from(
        '{"type":"assistant","message":{"session_id":"nested-session","thread_id":"nested-thread"},"text":"APPROVE workflow plan"}\n',
      ))
    }
    expect(calls).toBe(0)
    expect(() => stream.finish()).toThrow("invalid CLI reference stream")
    const valid = engine === "claude-code"
      ? '{"type":"system","subtype":"init","session_id":"too-late"}\n'
      : '{"type":"thread.started","thread_id":"too-late"}\n'
    expect(() => stream.onStdoutChunk(Buffer.from(valid))).toThrow("invalid CLI reference stream")
    expect(() => stream.finish()).toThrow("invalid CLI reference stream")
    expect(calls).toBe(0)
  })
}

test("CLI reference decoder fails closed on changed IDs, invalid UTF-8, oversized, truncated, and malformed frames", () => {
  let callbackCalls = 0
  const changed = createCLIReferenceStream({
    engine: "claude-code",
    executionID: "changed-id-execution",
    onReference() { callbackCalls++; return undefined },
  })
  changed.onStdoutChunk(Buffer.from('{"type":"system","subtype":"init","session_id":"first"}\n'))
  expect(() => changed.onStdoutChunk(Buffer.from('{"type":"system","subtype":"init","session_id":"second"}\n')))
    .toThrow("invalid CLI reference stream")
  expect(() => changed.onStdoutChunk(Buffer.from('{"type":"system","subtype":"init","session_id":"first"}\n')))
    .toThrow("invalid CLI reference stream")
  expect(() => changed.finish()).toThrow("invalid CLI reference stream")
  expect(callbackCalls).toBe(1)

  const laterAssistantID = createCLIReferenceStream({
    engine: "claude-code",
    executionID: "later-assistant-id",
    onReference() { callbackCalls++; return undefined },
  })
  laterAssistantID.onStdoutChunk(Buffer.from('{"type":"system","subtype":"init","session_id":"stable"}\n'))
  expect(() => laterAssistantID.onStdoutChunk(Buffer.from('{"type":"assistant","session_id":"changed"}\n')))
    .toThrow("invalid CLI reference stream")
  expect(callbackCalls).toBe(2)

  const missingInitID = createCLIReferenceStream({ engine: "claude-code", executionID: "missing-init", onReference() { return undefined } })
  expect(() => missingInitID.onStdoutChunk(Buffer.from('{"type":"system","subtype":"init"}\n')))
    .toThrow("invalid CLI reference stream")

  const invalidID = createCLIReferenceStream({ engine: "codex", executionID: "invalid-id", onReference() { return undefined } })
  expect(() => invalidID.onStdoutChunk(Buffer.from('{"type":"thread.started","thread_id":7}\n')))
    .toThrow("invalid CLI reference stream")

  const invalidUtf8 = createCLIReferenceStream({ engine: "codex", executionID: "invalid-utf8", onReference() { return undefined } })
  expect(() => invalidUtf8.onStdoutChunk(Uint8Array.from([0xff, 0x0a]))).toThrow("invalid CLI reference stream")

  const oversized = createCLIReferenceStream({ engine: "codex", executionID: "oversized", onReference() { return undefined } })
  expect(() => oversized.onStdoutChunk(new Uint8Array(1024 * 1024 + 1).fill(0x61)))
    .toThrow("invalid CLI reference stream")

  const truncated = createCLIReferenceStream({ engine: "claude-code", executionID: "truncated", onReference() { return undefined } })
  truncated.onStdoutChunk(Buffer.from('{"type":"system","subtype":"init","session_id":"unfinished"}'))
  expect(() => truncated.finish()).toThrow("invalid CLI reference stream")

  const malformed = createCLIReferenceStream({ engine: "codex", executionID: "malformed", onReference() { return undefined } })
  expect(() => malformed.onStdoutChunk(Buffer.from("not-json\n"))).toThrow("invalid CLI reference stream")
  expect(() => malformed.finish()).toThrow("invalid CLI reference stream")
})

test("CLI reference decoder snapshots engine, execution identity, and callback", () => {
  const references: unknown[] = []
  const observedOptions: {
    engine: CLIReferenceEngine
    executionID: string
    onReference(reference: ExecutionReference): undefined
  } = {
    engine: "claude-code" as CLIReferenceEngine,
    executionID: "original-execution",
    onReference(reference) { references.push(reference); return undefined },
  }
  const stream = createCLIReferenceStream(observedOptions)
  observedOptions.engine = "codex"
  observedOptions.executionID = "mutated-execution"
  observedOptions.onReference = () => {
    throw new Error("mutated callback")
  }
  stream.onStdoutChunk(Buffer.from('{"type":"system","subtype":"init","session_id":"original-session"}\n'))
  stream.finish()

  expect(references).toEqual([{ executionID: "original-execution", vendorSessionID: "original-session" }])
})

test("CLI reference identity is persisted before a later record failure", () => {
  const references: unknown[] = []
  const stream = createCLIReferenceStream({
    engine: "codex",
    executionID: "immediate-reference",
    onReference(reference) { references.push(reference); return undefined },
  })
  const firstFrame = Buffer.from('{"type":"thread.started","thread_id":"early-thread"}\n')
  const oversizedTail = Buffer.alloc(1024 * 1024 + 1, 0x61)
  expect(() => stream.onStdoutChunk(Buffer.concat([firstFrame, oversizedTail])))
    .toThrow("invalid CLI reference stream")
  expect(references).toEqual([{ executionID: "immediate-reference", vendorThreadID: "early-thread" }])
})

test("incremental CLI streams bind durable host references for both documented engines before exit", async () => {
  for (const engine of ["claude-code", "codex"] as const) {
    const executionID = `${engine}-process-reference`
    const fixture = executionFixture(engine, executionID)
    const persistedPath = join(fixture.worktree, "reference-persisted")
    const initial = fixture.runs.status().executions.find(record => record.executionId === executionID)
    expect(initial).toMatchObject({ hostDispatch: "started" })
    expect(initial?.vendorRef).toBeUndefined()
    const stream = createCLIReferenceStream({
      engine,
      executionID,
      onReference(reference) {
        fixture.runs.bindVendorRef(fixture.claim, executionID, JSON.stringify(reference))
        writeFileSync(persistedPath, "persisted", { flag: "wx" })
        return undefined
      },
    })

    try {
      const result = await createVendorProcess(options("reference-stream", [engine, persistedPath], {
        deadlineAt: Date.now() + 4000,
        onStdoutChunk: stream.onStdoutChunk,
      })).run()
      stream.finish()

      const statePath = join(executionRunDirectory(fixture.worktree), "state.json")
      const durableState = JSON.parse(readFileSync(statePath, "utf8")) as {
        executions: Array<{ executionId: string; engine: string; hostDispatch?: string; vendorRef?: string; boundaryRef?: unknown }>
      }
      const record = durableState.executions.find(value => value.executionId === executionID)
      const expectedReference = referenceFor(engine, executionID, canonicalFixtureID(engine))
      expect(existsSync(persistedPath)).toBe(true)
      expect(record).toMatchObject({ engine, hostDispatch: "started", vendorRef: JSON.stringify(expectedReference), boundaryRef: expectedReference })
      expect(result.status).toBe("completed")
      expect(result.captureComplete).toBe(true)
    } finally {
      fixture.cleanup()
    }
  }
}, { timeout: 8000 })

test("CLI reference callback scalar, async, and persistence failures stop bounded process completion", async () => {
  const unhandledRejections: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason) }
  process.on("unhandledRejection", onUnhandledRejection)
  try {
    for (const failureKind of ["scalar", "async", "persistence"] as const) {
      const engine = "claude-code"
      const executionID = `callback-${failureKind}-failure`
      const fixture = executionFixture(engine, executionID, failureKind === "persistence")
      const persistedPath = join(fixture.worktree, "reference-persisted")
      let callbackCalls = 0
      let stream: CLIReferenceStream
      if (failureKind === "scalar") {
        // @ts-expect-error reference persistence callbacks must return undefined
        stream = createCLIReferenceStream({ engine, executionID, onReference: () => { callbackCalls++; return 1 } })
      } else if (failureKind === "async") {
        // @ts-expect-error reference persistence callbacks must be synchronous
        stream = createCLIReferenceStream({ engine, executionID, onReference: async () => { callbackCalls++; throw new Error("private callback secret") } })
      } else {
        stream = createCLIReferenceStream({
          engine,
          executionID,
          onReference(reference) {
            callbackCalls++
            fixture.runs.bindVendorRef(fixture.claim, executionID, JSON.stringify(reference))
            return undefined
          },
        })
      }

      const startedAt = Date.now()
      try {
        const result = await createVendorProcess(options("reference-failure-wait", [engine, persistedPath], {
          deadlineAt: startedAt + 3000,
          termToKillMs: 100,
          onStdoutChunk: stream.onStdoutChunk,
        })).run()

        expect(Date.now() - startedAt).toBeLessThan(1800)
        expect(callbackCalls).toBe(1)
        expect(existsSync(persistedPath)).toBe(false)
        expect(result.status).toBe("failed")
        expect(result.signal).toBe("SIGKILL")
        expect(result.quiescent).toBe(true)
        expect(result.timedOut).toBe(false)
        expect(result.evidence).toContain("stdout observer failed")
        expect(result.evidence).not.toContain("private callback secret")
        expect(() => stream.finish()).toThrow("invalid CLI reference stream")
      } finally {
        fixture.cleanup()
      }
    }
    await delay(20)
    expect(unhandledRejections).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandledRejection)
  }
}, { timeout: 8000 })

test("preparation is inert and run is one-shot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const marker = join(directory, "started")
  const handle = createVendorProcess(options("marker", [marker]))

  expect(existsSync(marker)).toBe(false)
  expect(await handle.reconcile()).toEqual({ outcome: "terminal", quiescent: true, evidence: "process has not been started" })
  expect(existsSync(marker)).toBe(false)

  const result = await handle.run()
  expect(existsSync(marker)).toBe(true)
  expect(result.status).toBe("completed")
  expect(result.launched).toBe(true)
  expect(result.code).toBe(0)
  expect(result.signal).toBeNull()
  await expect(handle.run()).rejects.toThrow("one-shot")
}, { timeout: 4000 })

test("argv is literal, stdin and exit are captured, and child environment is exactly allowlisted", async () => {
  const previous = process.env.VENDOR_PROCESS_TEST_ONLY
  process.env.VENDOR_PROCESS_TEST_ONLY = "synthetic-test-value"
  try {
    const argv = ["two words", ";", "$(not-a-shell)", "--literal=value", "quote'\"", "雪"]
    const input = "fixture stdin only\n"
    const result = await createVendorProcess(options("report", argv, { stdin: input })).run()
    const newline = result.stdout.text.indexOf("\n")
    const report = JSON.parse(result.stdout.text.slice(0, newline)) as { args: string[]; envKeys: string[] }
    const expectedEnvKeys = ENV_ALLOWLIST.filter((key) => process.env[key] !== undefined).sort()

    expect(report.args).toEqual(argv)
    expect(report.envKeys).toEqual(expectedEnvKeys)
    expect(report.envKeys).not.toContain("VENDOR_PROCESS_TEST_ONLY")
    expect(result.stdout.text.slice(newline + 1)).toBe(input)
    expect(result.status).toBe("completed")
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.captureComplete).toBe(true)
    expect(result.stdout.complete).toBe(true)
    expect(result.stderr.complete).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.VENDOR_PROCESS_TEST_ONLY
    else process.env.VENDOR_PROCESS_TEST_ONLY = previous
  }
}, { timeout: 4000 })

test("oversized string and byte stdin are rejected before Buffer.from copies them", () => {
  const oversizedString = "雪".repeat(349_526)
  const oversizedBytes = new Uint8Array(1024 * 1024 + 1)
  const bufferFromDescriptor = Object.getOwnPropertyDescriptor(Buffer, "from")
  if (!bufferFromDescriptor) throw new Error("Buffer.from descriptor unavailable")
  let forbiddenCopies = 0
  let stringError: unknown
  let bytesError: unknown

  Object.defineProperty(Buffer, "from", {
    ...bufferFromDescriptor,
    value: (...args: unknown[]) => {
      if (args[0] === oversizedString || args[0] === oversizedBytes) {
        forbiddenCopies++
        throw new Error("oversized stdin copy attempted")
      }
      return Reflect.apply(bufferFromDescriptor.value as (...values: unknown[]) => Buffer, Buffer, args) as Buffer
    },
  })
  try {
    try { createVendorProcess(options("quick", [], { stdin: oversizedString })) } catch (error) { stringError = error }
    try { createVendorProcess(options("quick", [], { stdin: oversizedBytes })) } catch (error) { bytesError = error }
  } finally {
    Object.defineProperty(Buffer, "from", bufferFromDescriptor)
  }

  expect(stringError).toBeInstanceOf(TypeError)
  expect(bytesError).toBeInstanceOf(TypeError)
  expect(forbiddenCopies).toBe(0)
})

test("combined output cap is byte-bounded and partial capture is not success", async () => {
  const result = await createVendorProcess(options("burst", [], { maxCombinedOutputBytes: 11 })).run()
  expect(result.stdout.capturedBytes + result.stderr.capturedBytes).toBeLessThanOrEqual(11)
  expect(result.stdout.truncated || result.stderr.truncated).toBe(true)
  expect(result.captureComplete).toBe(false)
  expect(result.status).toBe("incomplete")
  expect(result.code).toBe(0)
}, { timeout: 4000 })

test("stdout observer persists accepted chunks synchronously before leader exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const releasePath = join(directory, "release")
  const delivered: Buffer[] = []
  let released = false
  const result = await createVendorProcess(options("observe-before-exit", [releasePath], {
    deadlineAt: Date.now() + 2500,
    onStdoutChunk(chunk) {
      delivered.push(Buffer.from(chunk))
      if (released) return undefined
      released = true
      writeFileSync(releasePath, "released", { flag: "wx" })
      return undefined
    },
  })).run()

  expect(released).toBe(true)
  expect(Buffer.concat(delivered).toString("utf8")).toBe("first\nsecond\n")
  expect(Buffer.concat(delivered).toString("utf8")).toBe(result.stdout.text)
  expect(result.status).toBe("completed")
}, { timeout: 4000 })

test("stdout observer receives only accepted bytes under the combined stderr cap", async () => {
  const delivered: Buffer[] = []
  const result = await createVendorProcess(options("mixed-output", [], {
    maxCombinedOutputBytes: 4,
    onStdoutChunk(chunk) {
      delivered.push(Buffer.from(chunk))
      expect(chunk).toBeInstanceOf(Uint8Array)
      return undefined
    },
  })).run()
  const deliveredBytes = Buffer.concat(delivered)

  expect(result.stderr.text).toBe("ab".slice(0, result.stderr.capturedBytes))
  expect(result.stderr.capturedBytes).toBeLessThanOrEqual(2)
  expect(result.stdout.capturedBytes).toBeLessThanOrEqual(4)
  expect(result.stdout.capturedBytes + result.stderr.capturedBytes).toBeLessThanOrEqual(4)
  expect(deliveredBytes.byteLength).toBe(result.stdout.capturedBytes)
  expect([...deliveredBytes]).toEqual([...Buffer.from("雪").subarray(0, result.stdout.capturedBytes)])
}, { timeout: 4000 })

test("stdout observer preserves a byte prefix when the cap splits UTF-8", async () => {
  const delivered: Buffer[] = []
  const result = await createVendorProcess(options("stdout-burst", [], {
    maxCombinedOutputBytes: 2,
    onStdoutChunk(chunk) { delivered.push(Buffer.from(chunk)); return undefined },
  })).run()

  expect(result.stdout.capturedBytes).toBe(2)
  expect(result.stdout.truncated).toBe(true)
  expect(result.stderr.capturedBytes).toBe(0)
  expect(Buffer.concat(delivered)).toEqual(Buffer.from("雪雪雪").subarray(0, 2))
}, { timeout: 4000 })

test("stdout observer mutation cannot change captured output", async () => {
  const delivered: Uint8Array[] = []
  const result = await createVendorProcess(options("quick", [], {
    onStdoutChunk(chunk) {
      delivered.push(chunk)
      chunk.fill(0)
      return undefined
    },
  })).run()

  const mutatedObserverChunks = Buffer.concat(delivered.map((chunk) => Buffer.from(chunk)))
  expect(mutatedObserverChunks).toEqual(Buffer.alloc(Buffer.byteLength("quick exit\n")))
  expect(result.stdout.text).toBe("quick exit\n")
  expect(result.status).toBe("completed")
}, { timeout: 4000 })

test("stdout observer failure stops delivery and uses bounded owned-handle cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const readyMarker = join(directory, "term-handler-ready")
  let callbackCalls = 0
  let firstChunkBytes = 0
  const startedAt = Date.now()
  const result = await createVendorProcess(options("ignore-term", [readyMarker, "5000"], {
    deadlineAt: Date.now() + 4000,
    termToKillMs: 300,
    onStdoutChunk(chunk) {
      callbackCalls++
      firstChunkBytes = chunk.byteLength
      throw new Error("private callback secret")
    },
  })).run()

  expect(Date.now() - startedAt).toBeLessThan(2000)
  expect(callbackCalls).toBe(1)
  expect(result.stdout.capturedBytes).toBeGreaterThan(firstChunkBytes)
  expect(result.status).toBe("failed")
  expect(result.status).not.toBe("completed")
  expect(result.evidence).toContain("stdout observer failed")
  expect(result.evidence).not.toContain("private callback secret")
  expect(result.signal).toBe("SIGKILL")
  expect(result.quiescent).toBe(true)
}, { timeout: 4000 })

test("async stdout observers are rejected by the type and drain runtime rejection", async () => {
  const unhandledRejections: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason) }
  process.on("unhandledRejection", onUnhandledRejection)
  try {
    const result = await createVendorProcess(options("quick", [], {
      // @ts-expect-error stdout persistence must finish synchronously
      onStdoutChunk: async () => { throw new Error("private async callback secret") },
    })).run()
    await delay(20)

    expect(result.status).toBe("failed")
    expect(result.status).not.toBe("completed")
    expect(result.evidence).toContain("stdout observer failed")
    expect(result.evidence).not.toContain("private async callback secret")
    expect(unhandledRejections).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandledRejection)
  }
}, { timeout: 4000 })

test("stdout observer rejects non-undefined scalar returns", async () => {
  const result = await createVendorProcess(options("quick", [], {
    // @ts-expect-error observer callbacks must return undefined
    onStdoutChunk: () => 1,
  })).run()

  expect(result.status).toBe("failed")
  expect(result.status).not.toBe("completed")
  expect(result.evidence).toContain("stdout observer failed")
}, { timeout: 4000 })

test("absolute deadline terminates an overlong process independently of pipe close", async () => {
  const startedAt = Date.now()
  const result = await createVendorProcess(options("sleep", ["5000"], { deadlineAt: Date.now() + 300 })).run()
  expect(Date.now() - startedAt).toBeLessThan(2000)
  expect(result.timedOut).toBe(true)
  expect(result.status).toBe("timed-out")
  expect(result.signal).toBe("SIGTERM")
  expect(result.quiescent).toBe(true)
}, { timeout: 4000 })

test("deadline escalation observes SIGKILL exit and quiescence within the bounded grace", async () => {
  const startedAt = Date.now()
  const deadlineAt = startedAt + 2000
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const readyMarker = join(directory, "term-handler-ready")
  const handle = createVendorProcess(options("ignore-term", [readyMarker, "5000"], {
    deadlineAt,
    termToKillMs: 100,
  }))
  const running = handle.run()
  const readyDeadline = Date.now() + 1200
  while (!existsSync(readyMarker) && Date.now() < readyDeadline) await delay(5)
  const fixtureWasReady = existsSync(readyMarker)

  const result = await running
  const reconciliation = await handle.reconcile()
  expect(fixtureWasReady).toBe(true)
  expect(Date.now() - startedAt).toBeLessThan(4000)
  expect(result.launched).toBe(true)
  expect(result.timedOut).toBe(true)
  expect(result.status).toBe("timed-out")
  expect(result.signal).toBe("SIGKILL")
  expect(result.quiescent).toBe(true)
  expect(reconciliation.outcome).toBe("terminal")
  expect(reconciliation.quiescent).toBe(true)
}, { timeout: 5000 })

test("cancellation near the run deadline retains post-SIGKILL observation grace", async () => {
  const startedAt = Date.now()
  const deadlineAt = startedAt + 2000
  const termToKillMs = 400
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const readyMarker = join(directory, "term-handler-ready")
  const handle = createVendorProcess(options("ignore-term", [readyMarker, "5000"], {
    deadlineAt,
    termToKillMs,
  }))
  const killDescriptor = Object.getOwnPropertyDescriptor(process, "kill")
  if (!killDescriptor) throw new Error("process.kill descriptor unavailable")
  const realKill = process.kill.bind(process)
  let sigkillObserved = false
  let delayedKill: Promise<void> | undefined
  Object.defineProperty(process, "kill", {
    ...killDescriptor,
    value: (pid: number, signal?: NodeJS.Signals | number): boolean => {
      if (pid < 0 && signal === "SIGKILL" && !sigkillObserved) {
        sigkillObserved = true
        // Model delayed signal delivery to this still-running owned fixture, without blocking timer dispatch.
        delayedKill = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            try { realKill(pid, signal); resolve() }
            catch (error) { reject(error) }
          }, 200)
        })
        void delayedKill.catch(() => {})
        return true
      }
      return realKill(pid, signal)
    },
  })

  try {
    const running = handle.run()
    const readyDeadline = Date.now() + 1200
    while (!existsSync(readyMarker) && Date.now() < readyDeadline) await delay(5)
    const fixtureWasReady = existsSync(readyMarker)
    let cancellation: Awaited<ReturnType<typeof handle.requestCancel>> | undefined
    if (fixtureWasReady) {
      while (Date.now() < deadlineAt - 150) await delay(5)
      cancellation = await handle.requestCancel("near-deadline cancellation", Date.now() + 2000)
    }

    const result = await running
    if (delayedKill) await delayedKill
    const reconciliation = await handle.reconcile()
    expect(fixtureWasReady).toBe(true)
    expect(cancellation?.requested).toBe(true)
    expect(sigkillObserved).toBe(true)
    expect(result.cancellationRequested).toBe(true)
    expect(result.timedOut).toBe(true)
    expect(result.status).toBe("timed-out")
    expect(result.signal).toBe("SIGKILL")
    expect(result.captureComplete).toBe(true)
    expect(result.quiescent).toBe(true)
    expect(reconciliation.outcome).toBe("terminal")
    expect(reconciliation.quiescent).toBe(true)
  } finally {
    if (delayedKill) await delayedKill.catch(() => {})
    Object.defineProperty(process, "kill", killDescriptor)
  }
}, { timeout: 5000 })

test("cancellation before start is acknowledged and permanently prevents launch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const marker = join(directory, "started")
  const handle = createVendorProcess(options("marker", [marker]))

  const cancellation = await handle.requestCancel("cancel before start", Date.now() + 1000)
  expect(cancellation).toEqual({ requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "cancellation prevented process launch" })
  const result = await handle.run()
  expect(result.status).toBe("cancelled")
  expect(result.launched).toBe(false)
  expect(result.quiescent).toBe(true)
  expect(existsSync(marker)).toBe(false)
}, { timeout: 4000 })

test("an expired cancellation request refuses without a process launch side effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const marker = join(directory, "started")
  const handle = createVendorProcess(options("marker", [marker]))

  const cancellation = await handle.requestCancel("expired request", Date.now())
  expect(cancellation).toEqual({
    requested: false,
    acknowledged: false,
    terminal: true,
    quiescent: true,
    evidence: "cancellation deadline elapsed before request",
  })
  expect(existsSync(marker)).toBe(false)
  expect(await handle.reconcile()).toEqual({ outcome: "terminal", quiescent: true, evidence: "process has not been started" })
  expect(existsSync(marker)).toBe(false)
}, { timeout: 4000 })

test("a run past its deadline reports terminal no-launch evidence everywhere", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const marker = join(directory, "started")
  const handle = createVendorProcess(options("marker", [marker], { deadlineAt: Date.now() - 1 }))

  const result = await handle.run()
  expect(result.status).toBe("timed-out")
  expect(result.launched).toBe(false)
  expect(result.timedOut).toBe(true)
  expect(result.quiescent).toBe(true)
  expect(result.evidence).toBe("deadline elapsed before process launch")
  expect(existsSync(marker)).toBe(false)

  expect(await handle.requestCancel("after no-launch timeout", Date.now() + 1000)).toEqual({
    requested: false,
    acknowledged: false,
    terminal: true,
    quiescent: true,
    evidence: "deadline elapsed before process launch",
  })
  expect(await handle.reconcile()).toEqual({
    outcome: "terminal",
    quiescent: true,
    evidence: "deadline elapsed before process launch",
  })
  expect(existsSync(marker)).toBe(false)
}, { timeout: 4000 })

test("queued cancellation survives its deadline elapsing before the spawn event", async () => {
  const handle = createVendorProcess(options("sleep", ["5000"], {
    deadlineAt: Date.now() + 3500,
    termToKillMs: 100,
  }))
  const running = handle.run()
  const cancelDeadlineAt = Date.now() + 100
  const pending = handle.requestCancel("queued", cancelDeadlineAt)

  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, 150)
  expect(Date.now()).toBeGreaterThan(cancelDeadlineAt)

  const cancellation = await pending
  expect(cancellation).toEqual({
    requested: true,
    acknowledged: false,
    terminal: false,
    quiescent: false,
    evidence: "cancellation queued for process startup",
  })

  const result = await running
  expect(result.cancellationRequested).toBe(true)
  expect(result.cancellationAcknowledged).toBe(true)
  expect(result.status).toBe("cancelled")
  expect(result.timedOut).toBe(false)
  expect(result.signal).not.toBeNull()
  expect(result.signal === "SIGTERM" || result.signal === "SIGKILL").toBe(true)
  expect(result.quiescent).toBe(true)
}, { timeout: 3000 })

test("ignored TERM escalates to KILL only while the owned leader remains live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const readyMarker = join(directory, "term-handler-ready")
  const handle = createVendorProcess(options("ignore-term", [readyMarker], { deadlineAt: Date.now() + 4000, termToKillMs: 100 }))
  const running = handle.run()
  const readyDeadline = Date.now() + 1000
  while (!existsSync(readyMarker) && Date.now() < readyDeadline) await delay(5)
  if (!existsSync(readyMarker)) {
    await handle.requestCancel("readiness timeout cleanup", Date.now() + 1000)
    await running
    expect(existsSync(readyMarker)).toBe(true)
    return
  }
  const cancellation = await handle.requestCancel("test cancellation", Date.now() + 2000)
  expect(cancellation.requested).toBe(true)

  const result = await running
  expect(result.cancellationRequested).toBe(true)
  expect(result.cancellationAcknowledged).toBe(true)
  expect(result.status).toBe("cancelled")
  expect(result.signal).toBe("SIGKILL")
  expect(result.quiescent).toBe(true)

  const settled = await handle.reconcile()
  expect(settled).toEqual({ outcome: "terminal", quiescent: true, evidence: "leader exited and process group is absent" })
  const killDescriptor = Object.getOwnPropertyDescriptor(process, "kill")
  const realKill = process.kill.bind(process)
  let groupCalls = 0
  Object.defineProperty(process, "kill", {
    configurable: true,
    enumerable: killDescriptor?.enumerable ?? true,
    writable: true,
    value: (pid: number, signal?: NodeJS.Signals | number): boolean => {
      if (pid < 0) groupCalls++
      return realKill(pid, signal)
    },
  })
  try {
    const repeated = await handle.requestCancel("repeat after settlement", Date.now() + 1000)
    expect(repeated).toEqual({ requested: false, acknowledged: false, terminal: true, quiescent: true, evidence: "leader exited and process group is absent" })
    expect(await handle.reconcile()).toEqual(settled)
    expect(groupCalls).toBe(0)
  } finally {
    if (killDescriptor) Object.defineProperty(process, "kill", killDescriptor)
    else Reflect.deleteProperty(process, "kill")
  }
  await expect(handle.run()).rejects.toThrow("one-shot")
}, { timeout: 6000 })

test("signal-time ESRCH revokes group authority without quiescence until leader exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vendor-process-test-"))
  tempDirectories.push(directory)
  const readyMarker = join(directory, "term-handler-ready")
  const handle = createVendorProcess(options("ignore-term", [readyMarker, "4200"], {
    deadlineAt: Date.now() + 2500,
    termToKillMs: 100,
  }))
  const killDescriptor = Object.getOwnPropertyDescriptor(process, "kill")
  if (!killDescriptor) throw new Error("process.kill descriptor unavailable")
  const realKill = process.kill.bind(process)
  let groupSignalCalls = 0
  let groupProbeCalls = 0
  let firstGroupSignal: NodeJS.Signals | number | undefined
  Object.defineProperty(process, "kill", {
    ...killDescriptor,
    value: (pid: number, signal?: NodeJS.Signals | number): boolean => {
      if (pid < 0) {
        if (signal === 0) groupProbeCalls++
        else {
          groupSignalCalls++
          firstGroupSignal ??= signal
          if (groupSignalCalls === 1 && signal === "SIGTERM") {
            throw Object.assign(new Error("synthetic group not found"), { code: "ESRCH" })
          }
        }
      }
      return realKill(pid, signal)
    },
  })

  const running = handle.run()
  try {
    const readyDeadline = Date.now() + 1500
    while (!existsSync(readyMarker) && Date.now() < readyDeadline) await delay(5)
    if (!existsSync(readyMarker)) {
      await handle.requestCancel("readiness timeout cleanup", Date.now() + 1000)
      await running
      expect(existsSync(readyMarker)).toBe(true)
      return
    }

    const cancellation = await handle.requestCancel("synthetic ESRCH case", Date.now() + 1500)
    expect(firstGroupSignal).toBe("SIGTERM")
    expect(cancellation.requested).toBe(true)
    expect(cancellation.acknowledged).toBe(false)
    expect(cancellation.terminal).toBe(false)
    expect(cancellation.quiescent).toBe(false)

    const observedWhileLeaderLives = await handle.reconcile()
    expect(observedWhileLeaderLives.outcome).toBe("running")
    expect(observedWhileLeaderLives.quiescent).toBe(false)
    expect(observedWhileLeaderLives.evidence).toBe("process group absence observed; leader terminal state is unobserved")

    const repeatedCancellation = await handle.requestCancel("repeat after ESRCH", Date.now() + 1500)
    expect(repeatedCancellation.requested).toBe(true)
    expect(repeatedCancellation.acknowledged).toBe(false)
    expect(repeatedCancellation.terminal).toBe(false)
    expect(repeatedCancellation.quiescent).toBe(false)
    expect(groupSignalCalls).toBe(1)
    expect(groupProbeCalls).toBe(0)

    const runResult = await running
    expect(runResult.timedOut).toBe(true)
    expect(runResult.status).toBe("unresolved")
    expect(runResult.quiescent).toBe(false)
    expect(runResult.code).toBeNull()
    expect(runResult.signal).toBeNull()
    const cancellationAfterDeadline = await handle.requestCancel("cancel after bounded result", Date.now() + 1000)
    expect(cancellationAfterDeadline.requested).toBe(false)
    expect(cancellationAfterDeadline.acknowledged).toBe(false)
    expect(cancellationAfterDeadline.terminal).toBe(false)
    expect(cancellationAfterDeadline.quiescent).toBe(false)
    expect(cancellationAfterDeadline.evidence).toBe("process group absence observed; leader terminal state is unobserved")
    expect(groupSignalCalls).toBe(1)
    expect(groupProbeCalls).toBe(0)

    const terminalDeadline = Date.now() + 2000
    let terminalObservation = await handle.reconcile()
    while (terminalObservation.outcome !== "terminal" && Date.now() < terminalDeadline) {
      await delay(10)
      terminalObservation = await handle.reconcile()
    }
    expect(terminalObservation).toEqual({
      outcome: "terminal",
      quiescent: true,
      evidence: "leader exited and process group is absent",
    })
    expect(groupSignalCalls).toBe(1)
    expect(groupProbeCalls).toBe(0)
  } finally {
    if (killDescriptor) Object.defineProperty(process, "kill", killDescriptor)
    else Reflect.deleteProperty(process, "kill")
  }
}, { timeout: 6000 })

test("leader exit with a naturally expiring pipe-holding grandchild is nonquiescent until observed", async () => {
  const handle = createVendorProcess(options("leader-with-grandchild", ["450"], { deadlineAt: Date.now() + 4000 }))
  const running = handle.run()
  const observationDeadline = Date.now() + 1000
  let reconciliation = await handle.reconcile()
  while (reconciliation.outcome !== "unknown" && Date.now() < observationDeadline) {
    await delay(10)
    reconciliation = await handle.reconcile()
  }

  expect(reconciliation.outcome).toBe("unknown")
  expect(reconciliation.quiescent).toBe(false)
  const cancellation = await handle.requestCancel("too late to signal exited leader", Date.now() + 1000)
  expect(cancellation.requested).toBe(false)
  expect(cancellation.acknowledged).toBe(false)
  expect(cancellation.terminal).toBe(true)
  expect(cancellation.quiescent).toBe(false)

  const result = await running
  expect(result.status).toBe("completed")
  expect(result.code).toBe(0)
  expect(result.captureComplete).toBe(true)
  expect(result.quiescent).toBe(true)
  expect(result.stdout.text).toContain("descendant finished")
}, { timeout: 5000 })

test("a pipe-holding descendant cannot extend run beyond deadline plus bounded escalation", async () => {
  const startedAt = Date.now()
  const handle = createVendorProcess(options("leader-with-grandchild", ["800", "silent"], {
    deadlineAt: Date.now() + 150,
    termToKillMs: 100,
  }))
  const result = await handle.run()
  expect(Date.now() - startedAt).toBeLessThan(1000)
  expect(result.timedOut).toBe(true)
  expect(result.status).toBe("unresolved")
  expect(result.quiescent).toBe(false)
  expect(result.captureComplete).toBe(false)
  await delay(Math.max(0, startedAt + 1000 - Date.now()))
}, { timeout: 3000 })

test("EPERM group probes remain unknown; invalid options refuse before launch", async () => {
  expect(() => createVendorProcess(options("quick", [], { cwd: "relative" }))).toThrow("invalid local process options")

  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "kill")
  const realKill = process.kill.bind(process)
  let deniedProbes = 0
  Object.defineProperty(process, "kill", {
    configurable: true,
    enumerable: originalDescriptor?.enumerable ?? true,
    writable: true,
    value: (pid: number, signal?: NodeJS.Signals | number): boolean => {
      if (pid < 0 && signal === 0) {
        deniedProbes++
        throw Object.assign(new Error("synthetic probe error"), { code: "EPERM" })
      }
      return realKill(pid, signal)
    },
  })
  try {
    const handle = createVendorProcess(options("quick", [], { deadlineAt: Date.now() + 3000 }))
    const result = await handle.run()
    expect(deniedProbes).toBeGreaterThan(0)
    expect(result.status).toBe("unresolved")
    expect(result.quiescent).toBe(false)
    const reconciliation = await handle.reconcile()
    expect(reconciliation).toEqual({
      outcome: "unknown",
      quiescent: false,
      evidence: "process-group probe was denied; quiescence is unknown",
    })
  } finally {
    if (originalDescriptor) Object.defineProperty(process, "kill", originalDescriptor)
    else Reflect.deleteProperty(process, "kill")
  }
}, { timeout: 5000 })

test("spawn failure is fixed, terminal evidence rather than an echoed command", async () => {
  const result = await createVendorProcess(options("quick", [], { executable: "/path/that/does/not/exist/vendor-fixture" })).run()
  expect(result.status).toBe("failed")
  expect(result.launched).toBe(false)
  expect(result.code).toBeNull()
  expect(result.quiescent).toBe(true)
  expect(result.evidence).toBe("local process could not be started")
  expect(result.evidence).not.toContain("vendor-fixture")
  expect(await createVendorProcess(options("quick")).reconcile()).toEqual({
    outcome: "terminal",
    quiescent: true,
    evidence: "process has not been started",
  })
}, { timeout: 4000 })
