import type { HookDeps } from "../hooks/types.ts"
import type { SkillPermissionSource } from "../routing/catalog.ts"

/** Adapt the current OpenCode main-agent settings to the host-neutral skill permission source contract. */
export function createOpenCodeSkillPermissionSource(
  deps: Pick<HookDeps, "client" | "directory">,
): SkillPermissionSource {
  return async (signal) => {
    const response = await deps.client.app.agents({ query: { directory: deps.directory }, signal })
    if (response.error || !Array.isArray(response.data)) return null
    const main = response.data.find((agent) => agent.name === "main")
    if (!main) return null
    return { skillEnabled: main.tools?.skill !== false, permissions: main.permission }
  }
}
