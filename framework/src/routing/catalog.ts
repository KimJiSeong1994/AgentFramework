import { z } from "zod"
import type { CoreDeps } from "../deps.ts"
import { skillPermissionAllowed } from "../skills/permission-source.ts"
import { discoverSkills, resolveSkillRoots } from "../skills/roots.ts"
import type { LocalSkillDescriptor } from "../skills/types.ts"

export type SkillCandidate = { name: string; description: string }
export type SkillPermissionSource = (signal: AbortSignal) => Promise<{ skillEnabled: boolean; permissions: unknown } | null>
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Project catalog only; global/external skills and symlinks escaping the worktree are not sent to inference. */
export async function availableCandidates(
  deps: CoreDeps,
  source: SkillPermissionSource,
  signal: AbortSignal,
): Promise<SkillCandidate[]> {
  const permissionSource = await source(signal)
  if (signal.aborted || !permissionSource || permissionSource.skillEnabled !== true) return []
  const names = [...new Set(deps.config.skills.allow)].filter((name) => NAME.test(name) && name !== "none")
  // No truncation: a larger catalog needs an explicitly evaluated retrieval strategy.
  if (names.length > 16) return []
  if (!names.length) return []

  const roots = await resolveSkillRoots({ projectRoot: deps.worktree })
  if (signal.aborted) return []
  const discovery = await discoverSkills(roots, { signal })
  if (signal.aborted) return []

  const descriptors = new Map<string, LocalSkillDescriptor[]>()
  for (const descriptor of discovery.descriptors) {
    if (descriptor.kind !== "skill" || descriptor.source !== "project") continue
    const matches = descriptors.get(descriptor.name) ?? []
    matches.push(descriptor)
    descriptors.set(descriptor.name, matches)
  }

  const result: SkillCandidate[] = []
  for (const name of names) {
    if (signal.aborted) return []
    if (!skillPermissionAllowed(permissionSource.permissions, name)) continue
    const matches = descriptors.get(name)
    // Discovery excludes ambiguous and protected names; require exactly one ordinary project descriptor.
    if (matches?.length !== 1) continue
    result.push({ name, description: matches[0]!.description })
  }
  return result
}
