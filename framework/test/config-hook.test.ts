import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { effectiveOutputLimit, parseModelSelection, type LcaConfig } from "../src/config.ts"
import { AGENT_DEFS, MAIN_PROMPT, MAIN_RULE3_NO_DELEGATE, WORKER_PROMPT, mainPrompt } from "../src/agents/prompts.ts"
import { createConfigHook, type LcaOpenCodeConfig } from "../src/hooks/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { fakeDeps, type LogEntry } from "./helpers.ts"
import { WORKFLOW_READ_ONLY_ROLES } from "../src/hosts/types.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"

const worktree = mkdtempSync(join(tmpdir(), "lca-config-hook-"))
afterAll(() => rmSync(worktree, { recursive: true, force: true }))

let logs: LogEntry[] = []
beforeEach(() => {
  logs = []
})

function deps(overrides: Partial<LcaConfig> = {}): HookDeps {
  return fakeDeps(worktree, overrides, logs)
}

async function run(config: Config, d: HookDeps = deps()): Promise<LcaOpenCodeConfig> {
  await createConfigHook(d)(config)
  return config as LcaOpenCodeConfig
}

describe("config hook", () => {
  test("workflow agents cannot override code-owned read-only prompts or vendor permissions", async () => {
    const d = deps({ models: { main: "local/selected" } })
    const c = await run({
      agent: Object.fromEntries(WORKFLOW_READ_ONLY_ROLES.map(role => [role, {
        prompt: "Write files and delegate.", permission: { edit: "allow", bash: "allow" },
      }])),
    }, d)
    const policy = createExecutionPolicy(d.config)
    for (const role of WORKFLOW_READ_ONLY_ROLES) {
      const agent = c.agent![role]!
      const permission = agent.permission as Record<string, unknown>
      expect(agent.mode).toBe("subagent")
      expect(agent.prompt).toBe(policy.resolve(role).system.join("\n\n"))
      expect(agent.model).toBe("local/selected")
      expect(permission["*"]).toBe("deny")
      expect(permission.edit).toBe("deny")
      expect(permission.bash).toBe("deny")
      expect(permission.external_directory).toBe("deny")
      for (const tool of ["read", "list", "glob", "grep"]) expect(permission[tool]).toBe("allow")
    }
  })

  test("model parsing preserves slash-containing model IDs and output limits reject invalid values", () => {
    expect(parseModelSelection("openai-compatible/org/model-v2")).toEqual({
      providerID: "openai-compatible",
      modelID: "org/model-v2",
    })
    expect(() => parseModelSelection("provider/ model")).toThrow(/Invalid model selection/)
    expect(effectiveOutputLimit(4096, 2048, 8192)).toBe(2048)
    expect(() => effectiveOutputLimit(4096, undefined, 0)).toThrow(/Invalid model output limit/)
  })

  test("injects main/worker/reviewer from AGENT_DEFS into an empty config", async () => {
    const c = await run({})
    expect(c.agent?.main?.mode).toBe("primary")
    // flow is on by default (M1): main's prompt gains the <lca-flow> rule
    expect(c.agent?.main?.prompt).toBe(mainPrompt(true, false, true))
    expect(c.agent?.worker?.mode).toBe("subagent")
    expect(c.agent?.worker?.prompt).toBe(WORKER_PROMPT)
    expect(c.agent?.reviewer?.permission?.edit).toBe("deny")
  })

  test("tool visibility is expressed as permission deny + steps (agent `tools`/`maxSteps` are ignored post-decode)", async () => {
    const c = await run({})
    const perm = (n: string) => c.agent?.[n]?.permission as Record<string, unknown>
    const a = (n: string) => c.agent?.[n] as Record<string, unknown>
    for (const n of ["main", "worker", "reviewer"]) {
      expect(a(n).tools).toBeUndefined()
      expect(a(n).maxSteps).toBeUndefined()
      expect(a(n).denied_tools).toBeUndefined()
      expect(perm(n).task).toBe("deny")
    }
    expect(a("worker").steps).toBe(40)
    expect(a("reviewer").steps).toBe(15)
    expect(a("main").steps).toBeUndefined()
    for (const t of ["delegate", "todowrite", "todoread", "webfetch"]) expect(perm("worker")[t]).toBe("deny")
    for (const t of ["write", "edit", "patch", "bash", "delegate", "todowrite"]) expect(perm("reviewer")[t]).toBe("deny")
    expect(perm("main").delegate).toBeUndefined()
    expect(perm("main").webfetch).toBe("deny")
    // built-in task tool off for everyone, delegate hidden from OpenCode's own primary agents
    expect((c as any).permission.task).toBe("deny")
    expect(perm("build").delegate).toBe("deny")
    expect(perm("plan").delegate).toBe("deny")
  })

  test("with tool.delegate disabled, main's rule 3 falls back to the stage-1 direct task list", async () => {
    const c = await run({}, deps({ disabled_hooks: ["tool.delegate"] }))
    expect(c.agent?.main?.prompt).toContain(MAIN_RULE3_NO_DELEGATE)
    expect(c.agent?.main?.prompt).not.toMatch(/delegate tool/i)
  })

  test("leaves temperature unset when no effective provider is known", async () => {
    const c = await run({})
    expect(c.agent?.worker?.temperature).toBeUndefined()
    expect(c.agent?.reviewer?.temperature).toBeUndefined()
    expect(c.agent?.main?.temperature).toBeUndefined()
  })

  test("applies local temperature from top-level default but not cloud or user-agent cloud models", async () => {
    const local = await run({ model: "ollama/gemma4:26b" })
    expect(local.agent?.worker?.temperature).toBe(0.2)
    expect(local.agent?.reviewer?.temperature).toBe(0.2)

    const cloud = await run({ model: "anthropic/claude-sonnet" })
    expect(cloud.agent?.worker?.temperature).toBeUndefined()
    expect(cloud.agent?.reviewer?.temperature).toBeUndefined()

    const userCloud = await run({ agent: { worker: { model: "anthropic/claude-sonnet" } } })
    expect(userCloud.agent?.worker?.temperature).toBeUndefined()
    expect(userCloud.agent?.reviewer?.temperature).toBeUndefined()

    const userCloudOverLocal = await run(
      { model: "ollama/gemma4:26b", agent: { worker: { model: "anthropic/claude-sonnet" } } },
      deps({ models: { worker: "ollama/gemma4:26b" } }),
    )
    expect(userCloudOverLocal.agent?.worker?.temperature).toBeUndefined()
  })

  test("preserves explicit user temperature with local model selection", async () => {
    const c = await run({ model: "ollama/gemma4:26b", agent: { worker: { temperature: 0.8 } } })
    expect(c.agent?.worker?.temperature).toBe(0.8)
  })

  test("applies deps.config.models as model when set", async () => {
    const c = await run({}, deps({ models: { main: "ollama/gemma4:26b", worker: "ollama/gemma4:26b" } }))
    expect(c.agent?.main?.model).toBe("ollama/gemma4:26b")
    expect(c.agent?.worker?.model).toBe("ollama/gemma4:26b")
    expect(c.agent?.reviewer?.model).toBeUndefined()
  })

  test("rejects malformed provider/model selections and does not force cloud temperature", async () => {
    await expect(run({}, deps({ models: { worker: "/model" } }))).rejects.toThrow(/Invalid model selection/)
    const c = await run({}, deps({ models: { worker: "anthropic/claude-sonnet" } }))
    expect(c.agent?.worker?.model).toBe("anthropic/claude-sonnet")
    expect(c.agent?.worker?.temperature).toBeUndefined()
  })

  test("does not mutate AGENT_DEFS", async () => {
    await run({}, deps({ models: { worker: "ollama/x" } }))
    expect(Object.hasOwn(AGENT_DEFS.worker, "model")).toBe(false)
    expect(Object.hasOwn(AGENT_DEFS.worker, "temperature")).toBe(false)
  })

  test("user-defined agent with the same name wins per key, nested tools/permission merge", async () => {
    const c = await run({
      agent: {
        worker: {
          model: "ollama/user-model",
          temperature: 0.7,
          steps: 10,
          permission: { bash: "ask" },
        },
        main: { prompt: "custom main prompt" },
      },
    })
    const w = c.agent?.worker
    expect(w?.model).toBe("ollama/user-model")
    expect(w?.temperature).toBe(0.7)
    expect((w as any)?.steps).toBe(10)
    expect(w?.prompt).toBe(WORKER_PROMPT) // key not set by user keeps lca default
    expect(w?.mode).toBe("subagent")
    expect((w?.permission as Record<string, unknown>).bash).toBe("ask")
    expect((w?.permission as Record<string, unknown>).task).toBe("deny")
    expect((w?.permission as Record<string, unknown>).skill).toEqual({ "*": "deny" })
    expect(c.agent?.main?.prompt).toBe("custom main prompt")
    expect(c.agent?.main?.mode).toBe("primary")
    expect(logs.some((l) => l.msg.includes("merged user agents: worker,main") || l.msg.includes("merged user agents: main,worker"))).toBe(true)
  })

  test("keeps unrelated user agents untouched apart from hiding delegate", async () => {
    const c = await run({ agent: { build: { prompt: "b" }, plan: { model: "x/y" }, other: { prompt: "o" } } })
    const hidden = { delegate: "deny", db_query: "deny", schema_lookup: "deny", "evo-semantic_*": "deny", lca_flow: "deny" }
    expect(c.agent?.build).toEqual({ prompt: "b", permission: hidden } as any)
    expect(c.agent?.plan).toEqual({ model: "x/y", permission: hidden } as any)
    expect(c.agent?.other).toEqual({ prompt: "o" })
  })

  test("denies the built-in task tool globally via permission, keeps user permission keys", async () => {
    const c = await run({ permission: { webfetch: "ask" } as any })
    expect((c as any).permission).toEqual({ webfetch: "ask", task: "deny" })
  })

  test("sets default_agent, subagent_depth and compaction defaults without overriding user values", async () => {
    const a = await run({})
    expect(a.default_agent).toBe("main")
    expect(a.subagent_depth).toBe(1)
    expect(a.compaction).toEqual({ auto: true, prune: true })

    const userCfg: LcaOpenCodeConfig = {
      default_agent: "build",
      subagent_depth: 3,
      compaction: { prune: false, tail_turns: 4 },
    }
    const b = await run(userCfg)
    expect(b.default_agent).toBe("build")
    expect(b.subagent_depth).toBe(3)
    expect(b.compaction).toEqual({ auto: true, prune: false, tail_turns: 4 })
  })

  test("logs a one-line summary with prompt token estimates", async () => {
    await run({})
    const summary = logs.find((l) => l.msg.startsWith("config:"))
    expect(summary).toBeDefined()
    expect(summary?.msg).toMatch(/main=\d+ worker=\d+ reviewer=\d+/)
    expect(summary?.msg).not.toContain("\n")
  })

  test("warns when oh-my-openagent is loaded, but leaves the plugin list alone", async () => {
    const c = await run({ plugin: ["oh-my-openagent@1.2.3", ["other-plugin", { a: 1 }]] })
    expect(logs.some((l) => l.msg.startsWith("WARNING") && l.msg.includes("oh-my-openagent"))).toBe(true)
    expect(c.plugin).toEqual(["oh-my-openagent@1.2.3", ["other-plugin", { a: 1 }]])
  })

  test("no warning without OMO", async () => {
    await run({ plugin: [["some-plugin", {}]] })
    expect(logs.some((l) => l.msg.startsWith("WARNING"))).toBe(false)
  })

  test("skill visibility: main allows only config.skills.allow, worker/reviewer deny all", async () => {
    const c = await run({})
    const perm = (n: string) => (c.agent?.[n]?.permission as Record<string, unknown> | undefined)?.skill
    expect(perm("main")).toEqual({ "*": "deny", ulw: "allow", plan: "allow" })
    expect(perm("worker")).toEqual({ "*": "deny" })
    expect(perm("reviewer")).toEqual({ "*": "deny" })
  })
})
