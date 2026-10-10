import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { CoreDeps } from "../src/deps.ts"
import { activateSkillCampaign, listSkillObservations, skillObservationBindingHash } from "../src/telemetry/skills.ts"
import { beginExecutionActivity, createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost } from "../src/hosts/types.ts"
import { tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

function deps(config = structuredClone(DEFAULT_CONFIG)): CoreDeps {
  return { directory: wt.worktree, worktree: wt.worktree, config, log() {} }
}

function host(engine = "runtime-fixture"): ExecutionHost {
  return {
    identity: { engine, profile: "test" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(request) {
      const reference = { executionID: request.executionID }
      return {
        reference,
        async run() { return { status: "completed" as const } },
        async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: "terminal" as const, quiescent: true, evidence: "fixture completed" } },
      }
    },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "no fixture execution" } },
  }
}

test("host factory receives the exact runtime policy and run store once without a client", async () => {
  const core = deps()
  const selectedHost = host()
  const received: Array<{ policy: unknown; runs: unknown }> = []
  const runtime = createExecutionRuntime(core, (parts) => {
    received.push(parts)
    return selectedHost
  })

  expect(received).toHaveLength(1)
  expect(received[0]?.policy).toBe(runtime.policy)
  expect(received[0]?.runs).toBe(runtime.runs)
  expect(runtime.host).toBe(selectedHost)
  expect(runtime.verificationProfile).toBe("legacy-unowned")
  expect(await runtime.verifier.preflight("legacy-unowned")).toEqual({ compatible: true, problems: [] })
  expect(runtime.linuxAdmission).toBeUndefined()
})

test("independent runtime factory calls are not cached and preserve verifier selection", async () => {
  const legacyDeps = deps()
  let hostFactoryCalls = 0
  const create = () => createExecutionRuntime(legacyDeps, () => {
    hostFactoryCalls++
    return host()
  })
  const first = create()
  const second = create()

  expect(hostFactoryCalls).toBe(2)
  expect(first).not.toBe(second)
  expect(first.policy).not.toBe(second.policy)
  expect(first.runs).not.toBe(second.runs)

  const linuxConfig = structuredClone(DEFAULT_CONFIG)
  linuxConfig.delegate.verifier = "linux-single-use"
  const linux = createExecutionRuntime(deps(linuxConfig), () => host())
  expect(linux.verificationProfile).toBe("linux-single-use")
  expect(linux.linuxAdmission).toBeDefined()
  expect(await linux.verifier.preflight("legacy-unowned")).toMatchObject({
    compatible: false,
    problems: [expect.stringContaining("unsupported verifier profile")],
  })
})

test("invalid verifier selection is refused before creating a host", () => {
  const invalidConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    delegate: { ...DEFAULT_CONFIG.delegate, verifier: "invalid-profile" },
  } as unknown as typeof DEFAULT_CONFIG
  let hostFactoryCalls = 0

  expect(() => createExecutionRuntime(deps(invalidConfig), () => {
    hostFactoryCalls++
    return host()
  })).toThrow("invalid verifier selection")
  expect(hostFactoryCalls).toBe(0)
})

test("runtime keeps real data checks and skill-observer callbacks wired for CoreDeps", async () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.data.backend = "sqlite"
  config.data.sqlite_path = join(wt.worktree, "runtime-checks.sqlite")
  const campaignID = "runtime-observer"
  config.skill_observation = {
    enabled: true,
    campaign_id: campaignID,
    owner_binding: skillObservationBindingHash(wt.worktree),
  }
  activateSkillCampaign(wt.worktree, campaignID)

  const database = new Database(config.data.sqlite_path, { create: true })
  database.exec("CREATE TABLE runtime_values (value INTEGER); INSERT INTO runtime_values VALUES (7)")
  database.close()

  const runtime = createExecutionRuntime(deps(config), () => host())
  expect(runtime.dataChecks).toBeDefined()
  const checks = await runtime.dataChecks!("SELECT value FROM runtime_values", "default")
  expect(checks).toMatchObject({ ok: true, rows: { columns: ["value"], rows: [[7]] } })

  expect(runtime.observe?.task).toBeFunction()
  expect(runtime.observe?.verification).toBeFunction()
  runtime.observe!.task!({
    sessionID: "runtime-session", taskID: "runtime-task", attemptID: "runtime-attempt",
    phase: "terminal", status: "done", taskStatus: "done",
  })
  runtime.observe!.verification!({
    sessionID: "runtime-session", verificationID: "runtime-verification", taskID: "runtime-task",
    attemptID: "runtime-attempt", phase: "terminal", status: "pass", codeOwned: true, exitCode: 0,
  })
  const facts = listSkillObservations(wt.worktree).facts
  expect(facts.map((fact) => fact.kind).sort()).toEqual(["task_context", "verification_observation"])
  expect(facts.find((fact) => fact.kind === "task_context")?.payload).toMatchObject({ taskID: "runtime-task", status: "done" })
  expect(facts.find((fact) => fact.kind === "verification_observation")?.payload)
    .toMatchObject({ verificationID: "runtime-verification", status: "pass", codeOwned: true })
})

test("canonical worktree activity excludes symlink aliases across runtime engines and releases by owner token", () => {
  const alias = join(wt.stateHome, "worktree-alias")
  symlinkSync(wt.worktree, alias, "dir")
  const firstRuntime = createExecutionRuntime(deps(), () => host("engine-one"))
  const secondRuntime = createExecutionRuntime({ ...deps(), directory: alias, worktree: alias }, () => host("engine-two"))
  expect(firstRuntime.host.identity.engine).not.toBe(secondRuntime.host.identity.engine)

  const firstRelease = beginExecutionActivity(firstRuntime, "session-one", "queue")
  expect(firstRelease).toBeFunction()
  expect(beginExecutionActivity(secondRuntime, "session-two", "review")).toBeNull()

  firstRelease!()
  firstRelease!()
  const secondRelease = beginExecutionActivity(secondRuntime, "session-two", "review")
  expect(secondRelease).toBeFunction()
  firstRelease!()
  expect(beginExecutionActivity(firstRuntime, "session-three", "queue")).toBeNull()

  secondRelease!()
  const thirdRelease = beginExecutionActivity(firstRuntime, "session-three", "queue")
  expect(thirdRelease).toBeFunction()
  thirdRelease!()
})

test("independent canonical worktrees have independent local activity slots", () => {
  const otherWorktree = mkdtempSync(join(tmpdir(), "lca-runtime-independent-"))
  try {
    const firstRuntime = createExecutionRuntime(deps(), () => host("engine-one"))
    const otherRuntime = createExecutionRuntime({
      ...deps(), directory: otherWorktree, worktree: otherWorktree,
    }, () => host("engine-two"))

    const firstRelease = beginExecutionActivity(firstRuntime, "session-one", "queue")
    const otherRelease = beginExecutionActivity(otherRuntime, "session-two", "review")
    expect(firstRelease).toBeFunction()
    expect(otherRelease).toBeFunction()
    firstRelease!()
    otherRelease!()
  } finally {
    rmSync(otherWorktree, { recursive: true, force: true })
  }
})

test("activity refuses an unavailable worktree instead of keying by a guessed path", () => {
  const missing = join(wt.worktree, "missing-worktree")
  expect(() => createExecutionRuntime({
    ...deps(), directory: missing, worktree: missing,
  }, () => host())).toThrow("cannot canonicalize")

  const invalidRuntime = createExecutionRuntime(deps(), () => host())
  rmSync(wt.worktree, { recursive: true })
  expect(beginExecutionActivity(invalidRuntime, "session-missing", "queue")).toBeNull()
})
