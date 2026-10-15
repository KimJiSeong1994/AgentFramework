import { z } from "zod"
import type { CoreDeps } from "../deps.ts"
import type { SkillPermissionSource } from "../routing/catalog.ts"

const ruleSchema = z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "deny", "ask"]) })

/** Evaluate normalized ordered host rules conservatively; unsupported glob syntax never grants visibility. */
export function skillPermissionAllowed(permissions: unknown, name: string): boolean {
  const parsed = z.array(ruleSchema).safeParse(permissions)
  if (!parsed.success) return false

  let action = "ask"
  for (const rule of parsed.data) {
    if (!/^[a-zA-Z0-9_.*?-]+$/.test(rule.permission)) return false
    if (!new Bun.Glob(rule.permission).match("skill")) continue
    if (!/^[a-zA-Z0-9_.*?-]+$/.test(rule.pattern)) return false
    if (new Bun.Glob(rule.pattern).match(name)) action = rule.action
  }
  return action === "allow"
}

/** Router visibility only; this does not grant skill invocation or tool authority. */
export function createConfigSkillPermissionSource(deps: Pick<CoreDeps, "config">): SkillPermissionSource {
  return async signal => {
    if (signal.aborted) return null
    return {
      skillEnabled: true,
      permissions: [
        { permission: "skill", pattern: "*", action: "deny" },
        ...deps.config.skills.allow.map(name => ({ permission: "skill", pattern: name, action: "allow" })),
      ],
    }
  }
}
