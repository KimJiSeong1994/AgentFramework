import type { HookDeps } from "../hooks/types.ts"
import type { SkillPermissionSource } from "../routing/catalog.ts"
import { EXECUTION_ROLES, type ExecutionRole } from "./types.ts"

/** Adapt one actual OpenCode role's current settings to the host-neutral skill visibility contract. */
export function createOpenCodeSkillPermissionSource(
  deps: Pick<HookDeps, "client" | "directory">,
  role: ExecutionRole = "main",
): SkillPermissionSource {
  return async (signal) => {
    if (signal.aborted || !(EXECUTION_ROLES as readonly string[]).includes(role)) return null
    const response = await deps.client.app.agents({ query: { directory: deps.directory }, signal })
    if (signal.aborted || response.error || !Array.isArray(response.data)) return null
    const matches = response.data.filter((candidate) => candidate.name === role)
    if (matches.length !== 1) return null
    const agent = matches[0]!
    return { skillEnabled: agent.tools?.skill !== false, permissions: agent.permission }
  }
}
