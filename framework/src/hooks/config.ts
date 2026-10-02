// `config` hook: inject lca agents + runtime contract into the OpenCode Config (mutated in place).
import type { Config, Hooks } from "@opencode-ai/plugin"
import type { AgentConfig } from "@opencode-ai/sdk"
import type { Config as ConfigV2 } from "@opencode-ai/sdk/v2"
import { AGENT_DEFS, DATA_AGENT_NAMES, EVO_TOOLS_ALLOWED, mainPrompt, type LcaAgentDef, type LcaAgentName } from "../agents/prompts.ts"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { estimateTokens } from "../tokens.ts"
import { enabled, type HookDeps } from "./types.ts"
import {
  APPROVE_COMMAND, APPROVE_DESCRIPTION, APPROVE_TEMPLATE, CANCEL_COMMAND, CANCEL_DESCRIPTION, CANCEL_TEMPLATE,
  PLAN_COMMAND, PLAN_DESCRIPTION, PLAN_TEMPLATE, REJECT_COMMAND, REJECT_DESCRIPTION, REJECT_TEMPLATE,
  STATUS_COMMAND, STATUS_DESCRIPTION, STATUS_TEMPLATE, STOP_COMMAND, STOP_DESCRIPTION, STOP_TEMPLATE,
  recordInjectedCommands,
} from "./command.ts"
import { flowOn } from "../flow/status.ts"

/**
 * The plugin package types the hook input with the v1 SDK Config, which lacks keys the running
 * OpenCode (and the v2 schema) accept. Borrow their exact shapes from the v2 type instead of
 * re-declaring them.
 */
type ConfigExtras = Pick<ConfigV2, "default_agent" | "subagent_depth" | "compaction">
export type LcaOpenCodeConfig = Config & ConfigExtras

const CORE_AGENT_NAMES: LcaAgentName[] = ["main", "worker", "reviewer"]

/** Vendored EvoOntology MCP server (framework/vendor/evoontology/evoontology/runtime/mcp_server.py). */
export function vendoredEvoServer(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // framework/src/hooks
  return join(here, "..", "..", "vendor", "evoontology", "evoontology", "runtime", "mcp_server.py")
}
const OMO_PREFIX = "oh-my-openagent"

function pluginName(entry: string | [string, unknown]): string {
  return typeof entry === "string" ? entry : entry[0]
}

/** Merge lca defaults with a user-defined agent of the same name. User wins per key; `tools` and `permission` merge one level deep. */
function mergeAgent(base: AgentConfig, user: AgentConfig): AgentConfig {
  const out: AgentConfig = { ...base, ...user }
  if (base.tools || user.tools) out.tools = { ...base.tools, ...user.tools }
  if (base.permission || user.permission) out.permission = { ...base.permission, ...user.permission }
  return out
}

export function createConfigHook(deps: HookDeps): NonNullable<Hooks["config"]> {
  return async (input) => {
    const config = input as LcaOpenCodeConfig

    // OMO also owns config.agent wholesale; the two plugins would fight over it. Warn, never remove.
    const plugins = (config.plugin ?? []).map(pluginName)
    if (plugins.some((p) => p.startsWith(OMO_PREFIX))) {
      deps.log(
        `WARNING: ${OMO_PREFIX} is loaded alongside lca. Both overwrite config.agent; disable one of them.`,
        { plugins },
      )
    }

    // (a) agents (data agents only when a backend is configured: their prompts + tool schemas are prefix cost)
    config.agent ??= {}
    const merged: string[] = []
    const dataOn = deps.config.data.backend !== "none" && enabled(deps.config, "tool.data")
    const AGENT_NAMES: LcaAgentName[] = dataOn ? [...CORE_AGENT_NAMES, ...DATA_AGENT_NAMES] : CORE_AGENT_NAMES
    for (const name of AGENT_NAMES) {
      const { denied_tools, ...def } = AGENT_DEFS[name] as LcaAgentDef
      const injected: AgentConfig = { ...def }
      if (name === "main") injected.prompt = mainPrompt(enabled(deps.config, "tool.delegate"), dataOn, flowOn(deps.config))
      const model = deps.config.models[name]
      if (model) injected.model = model
      if (name !== "main") injected.temperature = 0.2
      // Skill visibility: OpenCode lists only skills whose permission is not "deny" for the agent
      // (Skill service `available` filters by permission.evaluate("skill", name)). Deny everything but the allowlist
      // for main; worker/reviewer have the skill tool off entirely.
      const skillPerm: Record<string, "allow" | "deny"> = { "*": "deny" }
      if (name === "main") for (const sk of deps.config.skills.allow) skillPerm[sk] = "allow"
      // Tool visibility = permission deny (see AGENT_DEFS doc comment). `skill` and tool names are in the live
      // PermissionConfig schema but missing from the bundled v1 AgentConfig type.
      const denies: Record<string, unknown> = Object.fromEntries(denied_tools.map((t) => [t, "deny" as const]))
      // evo-semantic MCP tools: only browse/resolve, only for the analyst (rules are evaluated last-match-wins)
      if (name === "data-analyst") for (const t of EVO_TOOLS_ALLOWED) denies[t] = "allow"
      injected.permission = { ...injected.permission, "evo-semantic_*": "deny", ...denies, skill: skillPerm } as AgentConfig["permission"]
      const user = config.agent[name]
      if (user) merged.push(name)
      config.agent[name] = user ? mergeAgent(injected, user) : injected
    }

    // (b) built-in task tool off for every agent: orchestration is done by code, and its schema alone costs ~2.5K
    // prefix tokens. `config.tools` is ignored post-decode (same reason as agent `tools`), so use permission.
    ;(config as any).permission = { ...(config as any).permission, task: "deny" }
    // Plugin tools are registered for every agent; keep `delegate` main-only and the data tools analyst-only also for
    // OpenCode's built-in primary agents (Tab-switchable) so their prefix does not pay for them.
    for (const other of ["build", "plan"]) {
      const a = (config.agent[other] ??= {})
      a.permission = { ...a.permission, delegate: "deny", db_query: "deny", schema_lookup: "deny", "evo-semantic_*": "deny", lca_flow: "deny" } as AgentConfig["permission"]
    }

    // (b3) EvoOntology semantic MCP (stdio, vendored server). Registered only with a data backend and an existing
    // workspace; the analyst sees browse/resolve, everyone else has evo-semantic_* denied above.
    if (dataOn && deps.config.data.evo.enabled && enabled(deps.config, "mcp.evo")) {
      const evo = deps.config.data.evo
      const workspace = isAbsolute(evo.workspace) ? evo.workspace : join(deps.worktree, evo.workspace)
      const server = evo.server || vendoredEvoServer()
      if (!existsSync(server)) deps.log("evo-semantic MCP not registered: server script missing", { server })
      else if (!existsSync(join(workspace, "active.json"))) deps.log("evo-semantic MCP not registered: workspace has no active.json", { workspace })
      else {
        const mcp = ((config as any).mcp ??= {})
        mcp["evo-semantic"] ??= {
          type: "local",
          command: [evo.python, server, "--store", workspace],
          environment: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
          timeout: 10_000,
        }
      }
    }

    // (b2) /stop and /status commands (handled in hooks/command.ts). A user-defined command with the same name
    // wins (spread after the lca default); `injectedNames` records only the names lca actually wrote so
    // hooks/command.ts never acts on a shadowed name (ARCH-13). `lca_flow` is not registered in M0 (ARCH-06).
    const injectedNames = new Set<string>()
    if (enabled(deps.config, "command.stop")) {
      config.command = { [STOP_COMMAND]: { template: STOP_TEMPLATE, description: STOP_DESCRIPTION }, ...config.command }
      if (!config.command[STOP_COMMAND] || config.command[STOP_COMMAND].template === STOP_TEMPLATE) injectedNames.add(STOP_COMMAND)
    }
    if (flowOn(deps.config) && enabled(deps.config, "command.status")) {
      config.command = { [STATUS_COMMAND]: { template: STATUS_TEMPLATE, description: STATUS_DESCRIPTION }, ...config.command }
      if (config.command[STATUS_COMMAND]?.template === STATUS_TEMPLATE) injectedNames.add(STATUS_COMMAND)
    }
    // M1: plan/approve/reject/cancel, gated on flow being on (same feature switch as lca_flow/the boundary/status).
    if (flowOn(deps.config)) {
      const flowCmds: Array<[string, string, string]> = [
        [PLAN_COMMAND, PLAN_TEMPLATE, PLAN_DESCRIPTION],
        [APPROVE_COMMAND, APPROVE_TEMPLATE, APPROVE_DESCRIPTION],
        [REJECT_COMMAND, REJECT_TEMPLATE, REJECT_DESCRIPTION],
        [CANCEL_COMMAND, CANCEL_TEMPLATE, CANCEL_DESCRIPTION],
      ]
      for (const [name, template, description] of flowCmds) {
        config.command = { [name]: { template, description }, ...config.command }
        if (config.command[name]?.template === template) injectedNames.add(name)
      }
    }
    recordInjectedCommands(deps, injectedNames)

    // (c)-(e) runtime defaults; user config wins where already set.
    config.default_agent ??= "main"
    config.compaction = { auto: true, prune: true, ...config.compaction }
    config.subagent_depth ??= 1

    // (f)
    const est = Object.fromEntries(
      AGENT_NAMES.map((n) => [n, estimateTokens(String(config.agent?.[n]?.prompt ?? ""))]),
    )
    deps.log(
      `config: agents main/worker/reviewer injected (prompt est. tokens main=${est.main} worker=${est.worker} reviewer=${est.reviewer}), task tool off, default_agent=${config.default_agent}, subagent_depth=${config.subagent_depth}, compaction=${JSON.stringify(config.compaction)}${merged.length ? `, merged user agents: ${merged.join(",")}` : ""}`,
    )
  }
}
