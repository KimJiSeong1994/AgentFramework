import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCodexProfile } from "../src/hosts/codex-profile.ts"
import type { CliTransportHandle, CliTransportOptions } from "../src/hosts/cli-transport.ts"
import { EXECUTION_ROLES } from "../src/hosts/types.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => wt.cleanup())

const base = () => ({ worktree: wt.worktree, engine: "local" as const, model: "anchor-model" })

describe("combo routes in the CLI runtime policy", () => {
  test("a routed role resolves the routed model; every other role is exactly the unrouted policy", () => {
    const plain = createCliRuntime(base())
    const routed = createCliRuntime({ ...base(), routes: { planner: { engine: "claude", model: "opus" } } })
    expect(routed.policy.resolve("planner").model).toEqual({ providerID: "claude", modelID: "opus" })
    expect(routed.policy.resolve("planner").id).not.toBe(plain.policy.resolve("planner").id)
    for (const role of EXECUTION_ROLES) {
      if (role !== "planner") expect(routed.policy.resolve(role)).toEqual(plain.policy.resolve(role))
    }
    expect(routed.host.identity.engine).toBe("local")
  })

  test("routes equal to the anchor are dropped and change no ID; empty routes match no routes", () => {
    const plain = createCliRuntime(base())
    const same = createCliRuntime({ ...base(), routes: { planner: { engine: "local", model: "anchor-model" } } })
    const empty = createCliRuntime({ ...base(), routes: {} })
    for (const role of EXECUTION_ROLES) {
      expect(same.policy.resolve(role)).toEqual(plain.policy.resolve(role))
      expect(empty.policy.resolve(role)).toEqual(plain.policy.resolve(role))
    }
  })

  test("a Codex route carries its native context only on that role; local and claude routes have none", () => {
    const profile = createCodexProfile("gpt-6-astra")
    const runtime = createCliRuntime({
      ...base(),
      routes: {
        architect: { engine: "codex", model: "gpt-6-astra" },
        critic: { engine: "claude", model: "sonnet" },
        worker: { engine: "local", model: "qwen3-coder:30b" },
      },
    })
    expect(runtime.policy.resolve("architect").nativeContext).toEqual({ identity: profile.catalogHash, instructions: profile.instructions })
    for (const role of EXECUTION_ROLES) {
      if (role !== "architect") expect(runtime.policy.resolve(role).nativeContext).toBeUndefined()
    }
    expect(runtime.policy.resolve("critic").model).toEqual({ providerID: "claude", modelID: "sonnet" })
    expect(runtime.policy.resolve("worker").model).toEqual({ providerID: "local", modelID: "qwen3-coder:30b" })
  })

  test("a Codex anchor keeps its context on unrouted roles while a non-Codex route has none", () => {
    const anchor = createCodexProfile("gpt-6-astra")
    const runtime = createCliRuntime({ ...base(), engine: "codex", model: "gpt-6-astra", routes: { worker: { engine: "local", model: "q" } } })
    expect(runtime.policy.resolve("planner").nativeContext?.identity).toBe(anchor.catalogHash)
    expect(runtime.policy.resolve("worker").nativeContext).toBeUndefined()
  })

  test("routes never widen role tool policy", () => {
    const plain = createCliRuntime(base())
    const routed = createCliRuntime({ ...base(), routes: { reviewer: { engine: "claude", model: "opus" }, planner: { engine: "claude", model: "opus" } } })
    for (const role of ["reviewer", "planner"] as const) {
      expect(routed.policy.resolve(role).tools).toEqual(plain.policy.resolve(role).tools)
    }
  })

  test("unknown Codex slug, main route, unknown role or bad model refuse runtime creation", () => {
    expect(() => createCliRuntime({ ...base(), routes: { architect: { engine: "codex", model: "not-a-bundled-slug" } } }))
      .toThrow("not a bundled Codex model slug")
    expect(() => createCliRuntime({ ...base(), routes: { main: { engine: "claude", model: "opus" } } as never })).toThrow(TypeError)
    expect(() => createCliRuntime({ ...base(), routes: { nope: { engine: "claude", model: "opus" } } as never })).toThrow(TypeError)
    expect(() => createCliRuntime({ ...base(), routes: { planner: { engine: "claude", model: "--x" } } })).toThrow(TypeError)
  })

  test("createCliRuntime preflight probes the anchor and every routed target through the host", async () => {
    const targets: string[] = []
    const createTransport = (options: CliTransportOptions): CliTransportHandle => {
      targets.push(`${options.engine}/${options.model}`)
      return {
        async run() { return { status: "completed", text: "", quiescent: true } },
        async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture" } },
      }
    }
    const runtime = createCliRuntime({
      ...base(), createTransport,
      routes: { planner: { engine: "claude", model: "opus" }, worker: { engine: "local", model: "qwen3" } },
    })
    const result = await runtime.host.preflight(runtime.host.identity.profile)
    expect(result).toMatchObject({ compatible: true, problems: [] })
    expect([...targets].sort()).toEqual(["claude/opus", "local/anchor-model", "local/qwen3"])
  })

  test("createCliRuntime dispatches each role on its own route and never on the anchor for a failed route", async () => {
    const prepared: string[] = []
    const createTransport = (options: CliTransportOptions): CliTransportHandle => {
      prepared.push(`${options.engine}/${options.model}`)
      if (options.engine === "claude") throw new Error("fixture claude unavailable")
      return {
        async run() { return { status: "completed", text: JSON.stringify({ type: "final", text: "ok" }), quiescent: true } },
        async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture" } },
      }
    }
    const dispatch = async (role: "planner" | "worker") => {
      if (role === "worker") { wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) }
      const runtime = createCliRuntime({ ...base(), createTransport, routes: { planner: { engine: "claude", model: "opus" } } })
      const claim = runtime.runs.claim("s", "instance", process.pid)
      const partial = {
        executionID: `exec-${role}`, supervisorSessionID: "s", taskID: "t", attemptID: "a", generation: claim.generation, role,
        title: "t", cwd: wt.worktree, text: "x", deadlineAt: Date.now() + 10_000, policy: runtime.policy.resolve(role),
      }
      runtime.runs.registerIntent(claim, {
        executionId: partial.executionID, ownerSession: "s", taskId: "t", attemptId: "a", generation: claim.generation, role,
        cwd: wt.worktree, policyID: partial.policy.id, kind: "host", engine: "local", profile: "legacy-unowned",
        controlProfile: runtime.host.identity.controlProfile,
      })
      const handle = await runtime.host.prepare({ ...partial, handlers: runtime.policy.handlers(partial) } as Parameters<typeof runtime.host.prepare>[0])
      return handle.run()
    }
    expect(await dispatch("planner")).toMatchObject({ status: "failed", error: "CLI inference transport could not be prepared" })
    expect(prepared).toEqual(["claude/opus"])
    expect(await dispatch("worker")).toMatchObject({ status: "completed" })
    expect(prepared).toEqual(["claude/opus", "local/anchor-model"])
  })
})
