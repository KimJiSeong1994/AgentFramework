// Code-owned harness profile (S0). Read-only: filesystem reads and hashing only, no runtime, no model call.
// It describes IDENTITY (which parts of the agent are code-owned and hash-bound, which part a probe may carry as
// task data), not quality, and is not proof that any skill loads. See ../workflows/ATTRIBUTION for the component
// taxonomy (c1..c8) adapted from google-research/harness2.
import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import type { OtterConfig } from "../config.ts"
import { canonicalJson } from "../guards/repeat.ts"
import { createExecutionPolicy } from "../hosts/tool-policy.ts"
import { EXECUTION_ROLES } from "../hosts/types.ts"
import { containsSecret } from "../security/secrets.ts"
import { discoverSkills, resolveSkillRoots, skillDirectoryPath } from "../skills/roots.ts"

export const PROFILE_SCHEMA = "otter.harness-profile.v1" as const
const MAX_SKILL_BYTES = 16 * 1024
const IMPORT_BASES = new Set(["project:.claude/skills", "project:.codex/skills", "home:.codex/skills"])

export type ProfileComponent = Readonly<{
  id: string
  owner: "code" | "human" | "probe"
  proposable: boolean
  identity: "policy" | "skill-sha256" | "none" | "task-data"
}>
export type ProfileSkill = Readonly<{ name: string; tier: "native" | "import"; skillSha256: string }>
export type HarnessProfile = Readonly<{
  schema: typeof PROFILE_SCHEMA
  components: readonly ProfileComponent[]
  policyIDs: Readonly<Record<string, string>>
  skills: readonly ProfileSkill[]
  fingerprint: string
}>

const COMPONENTS: readonly ProfileComponent[] = Object.freeze([
  { id: "c1.system", owner: "code", proposable: false, identity: "policy" },
  { id: "c2.guardrails", owner: "code", proposable: false, identity: "policy" },
  { id: "c3.memory", owner: "human", proposable: false, identity: "none" },
  { id: "c4.tool_guidance", owner: "code", proposable: false, identity: "policy" },
  { id: "c5.subagents", owner: "code", proposable: false, identity: "policy" },
  { id: "c6.skills", owner: "human", proposable: false, identity: "skill-sha256" },
  { id: "c7.scripts", owner: "code", proposable: false, identity: "none" },
  { id: "c8.plugins_hooks", owner: "code", proposable: false, identity: "none" },
  { id: "overlay.inv", owner: "probe", proposable: true, identity: "task-data" },
  { id: "overlay.dom", owner: "probe", proposable: true, identity: "task-data" },
].map((component) => Object.freeze(component) as ProfileComponent))

export type HarnessProfileOptions = Readonly<{ homeDirectory?: string }>

export async function harnessProfile(config: Readonly<OtterConfig>, worktree: string, options: HarnessProfileOptions = {}): Promise<HarnessProfile> {
  // `skill_auto` (user-config skill selection) never shapes a role; tool-policy excludes chat/memory/skill_trust the same way.
  const { skill_auto: _auto, ...policyConfig } = config as Readonly<OtterConfig> & { skill_auto?: unknown }
  const policy = createExecutionPolicy(policyConfig as Readonly<OtterConfig>)
  const policyIDs: Record<string, string> = {}
  for (const role of EXECUTION_ROLES) policyIDs[role] = policy.resolve(role).id

  const roots = await resolveSkillRoots({ projectRoot: worktree, ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }) })
  const discovery = await discoverSkills(roots)
  const skills: ProfileSkill[] = []
  for (const descriptor of discovery.descriptors) {
    if (descriptor.kind !== "skill") continue
    const file = `${skillDirectoryPath(roots, descriptor)}/SKILL.md`
    const real = realpathSync(file)
    if (statSync(real).size > MAX_SKILL_BYTES) throw new RangeError(`skill ${descriptor.name} SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`)
    const base = descriptor.identity.slice(0, descriptor.identity.lastIndexOf("/"))
    skills.push(Object.freeze({
      name: descriptor.name,
      tier: IMPORT_BASES.has(base) ? "import" : "native",
      skillSha256: createHash("sha256").update(readFileSync(real)).digest("hex"),
    }))
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, "en"))

  const body = { schema: PROFILE_SCHEMA, components: COMPONENTS, policyIDs, skills }
  const canonical = canonicalJson(body)
  if (containsSecret(canonical)) throw new Error("harness profile refused: secret-like content")
  const fingerprint = createHash("sha256").update(canonical).digest("hex")
  return Object.freeze({ ...body, policyIDs: Object.freeze(policyIDs), skills: Object.freeze(skills), fingerprint })
}

export function renderProfile(profile: HarnessProfile): string {
  const lines = [`harness profile ${profile.schema}`, `fingerprint ${profile.fingerprint}`, "components:"]
  for (const c of profile.components) lines.push(`  ${c.id}  owner=${c.owner}  proposable=${c.proposable}  identity=${c.identity}`)
  lines.push("policy ids:")
  for (const [role, id] of Object.entries(profile.policyIDs)) lines.push(`  ${role}  ${id}`)
  lines.push(`skills (${profile.skills.length}):`)
  for (const s of profile.skills) lines.push(`  ${s.name}  ${s.tier}  ${s.skillSha256}`)
  return lines.join("\n")
}
