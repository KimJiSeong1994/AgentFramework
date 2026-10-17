import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import baseline from "./fixtures/legacy-policy-ids.json"

// P0 freezes these identities before UI/discovery changes. Separate processes
// prevent module caches from hiding environment-dependent policy drift.
test("legacy role identities survive UI toggles and unrelated home skill roots", () => {
  const home = mkdtempSync(join(tmpdir(), "otter-policy-home-"))
  try {
    mkdirSync(join(home, ".agents", "skills"), { recursive: true })
    mkdirSync(join(home, ".claude", "skills"), { recursive: true })
    const source = `
      import { DEFAULT_CONFIG } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).pathname)};
      import { createExecutionPolicy } from ${JSON.stringify(new URL("../src/hosts/tool-policy.ts", import.meta.url).pathname)};
      const roles = ${JSON.stringify(Object.keys(baseline.fixtures[0]!.snapshots))};
      console.log(JSON.stringify([false,true].map(planningOnlyMain => {
        const policy = createExecutionPolicy(DEFAULT_CONFIG,{planningOnlyMain});
        return {planningOnlyMain,snapshots:Object.fromEntries(roles.map(role=>[role,policy.resolve(role)]))};
      })));
    `
    for (const enabled of ["0", "1"]) {
      const result = Bun.spawnSync([process.execPath, "-e", source], {
        env: { ...process.env, HOME: home, OTTER_TUI: enabled, NO_COLOR: "1" },
        stdout: "pipe", stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual(baseline.fixtures)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("a persisted chat default model or skill trust list never changes role identity", async () => {
  const { DEFAULT_CONFIG } = await import("../src/config.ts")
  const { createExecutionPolicy } = await import("../src/hosts/tool-policy.ts")
  const plain = createExecutionPolicy(DEFAULT_CONFIG, { planningOnlyMain: true })
  const withDefault = createExecutionPolicy({ ...DEFAULT_CONFIG, chat: { default_model: { engine: "codex", model: "gpt-5-codex" } },
    skill_trust: ["code-review", "~/.codex/skills"] } as typeof DEFAULT_CONFIG, { planningOnlyMain: true })
  for (const role of Object.keys(baseline.fixtures[0]!.snapshots)) {
    expect(withDefault.resolve(role as never).id).toBe(plain.resolve(role as never).id)
  }
  // Identity still follows real policy input.
  const changed = createExecutionPolicy({ ...DEFAULT_CONFIG, max_output: { ...DEFAULT_CONFIG.max_output, worker: 1 } }, { planningOnlyMain: true })
  expect(changed.resolve("worker").id).not.toBe(plain.resolve("worker").id)
})

test("CLI selection preserves frozen model keys and old serialized policy inputs", () => {
  const home = mkdtempSync(join(tmpdir(), "otter-policy-cli-home-"))
  const worktree = join(home, "worktree")
  mkdirSync(worktree)
  try {
    const source = `
      import { createCliRuntime } from ${JSON.stringify(new URL("../src/hosts/cli-runtime.ts", import.meta.url).pathname)};
      import { EXECUTION_ROLES } from ${JSON.stringify(new URL("../src/hosts/types.ts", import.meta.url).pathname)};
      const runtime = createCliRuntime({worktree:${JSON.stringify(worktree)},engine:"local",model:"llama3.2:3b"});
      console.log(JSON.stringify({config:runtime.config,snapshots:Object.fromEntries(EXECUTION_ROLES.map(role=>[role,runtime.policy.resolve(role)]))}));
    `
    const captured = baseline.fixtures.find(fixture => fixture.planningOnlyMain)!
    const selected = { providerID: "local", modelID: "llama3.2:3b" }
    const expectedConfig = {
      ...baseline.config,
      models: Object.fromEntries(Object.keys(captured.snapshots).map(role => [role, "local/llama3.2:3b"])),
    }
    for (const enabled of ["0", "1"]) {
      const result = Bun.spawnSync([process.execPath, "-e", source], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), OTTER_TUI: enabled },
        stdout: "pipe", stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      const actual = JSON.parse(result.stdout.toString())
      // The runtime carries `chat` (launch selection), but role identity is still derived from the frozen policy input.
      expect(actual.config).toEqual({ ...expectedConfig, chat: {} })
      for (const [name, snapshot] of Object.entries(captured.snapshots)) {
        const { id: _id, role, ...rest } = snapshot
        const resolved = { role, model: selected, ...rest }
        const id = `otter:${name}:${createHash("sha256").update(JSON.stringify({ resolved, config: expectedConfig })).digest("hex")}`
        expect(actual.snapshots[name]).toEqual({ id, ...resolved })
      }
      for (const name of ["interviewer", "planner", "architect", "critic", "researcher", "contrarian", "simplifier"]) {
        expect(actual.snapshots[name].model).toEqual(selected)
        expect(actual.config.models[name]).toBeUndefined()
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("chat.combo in config alone changes no ID; empty routes match the frozen baseline; only a routed role differs", async () => {
  const { DEFAULT_CONFIG } = await import("../src/config.ts")
  const { createExecutionPolicy } = await import("../src/hosts/tool-policy.ts")
  const roles = Object.keys(baseline.fixtures[0]!.snapshots) as never[]
  const plain = createExecutionPolicy(DEFAULT_CONFIG, { planningOnlyMain: true })
  const withCombo = createExecutionPolicy({ ...DEFAULT_CONFIG, chat: { combo: { planner: { engine: "claude", model: "opus" } } } } as typeof DEFAULT_CONFIG, { planningOnlyMain: true })
  const empty = createExecutionPolicy(DEFAULT_CONFIG, { planningOnlyMain: true, routes: {} })
  for (const role of roles) {
    expect(withCombo.resolve(role).id).toBe(plain.resolve(role).id)
    expect(empty.resolve(role)).toEqual(plain.resolve(role))
  }
  const routed = createExecutionPolicy(DEFAULT_CONFIG, { planningOnlyMain: true, routes: { planner: { model: { providerID: "claude", modelID: "opus" } } } })
  for (const role of roles) {
    if (role === "planner") expect(routed.resolve(role).id).not.toBe(plain.resolve(role).id)
    else expect(routed.resolve(role)).toEqual(plain.resolve(role))
  }
  expect(routed.resolve("planner").model).toEqual({ providerID: "claude", modelID: "opus" })
})
