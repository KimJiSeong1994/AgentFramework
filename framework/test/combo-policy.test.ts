import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCodexProfile } from "../src/hosts/codex-profile.ts"
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
      .toThrow("unknown Codex bundled model slug")
    expect(() => createCliRuntime({ ...base(), routes: { main: { engine: "claude", model: "opus" } } as never })).toThrow(TypeError)
    expect(() => createCliRuntime({ ...base(), routes: { nope: { engine: "claude", model: "opus" } } as never })).toThrow(TypeError)
    expect(() => createCliRuntime({ ...base(), routes: { planner: { engine: "claude", model: "--x" } } })).toThrow(TypeError)
  })
})
