// Operator-configured skill trust: `skill_trust` in the *user* config (~/.config/otter/otter.jsonc) only.
// A trusted skill is used without the per-session "Allow this content" prompt. Trust is by skill name or by
// folder and deliberately ignores content changes. A project's `.otter/otter.jsonc` can never supply it, so a cloned
// repository cannot approve its own (or the operator's home) skills. Trust grants nothing beyond that prompt:
// tool permissions, execution approval and path restrictions are unchanged.
import { readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { parseJsonc, userConfigPath } from "../config.ts"
import { skillDirectoryPath } from "./roots.ts"
import type { SkillDescriptor, SkillRoots } from "./types.ts"

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const MAX_ENTRIES = 256

export type SkillTrust = Readonly<{ names: ReadonlySet<string>; folders: readonly string[] }>
export type SkillTrustLookup = Readonly<{ trust: SkillTrust; problem?: string; source: string }>

export const NO_SKILL_TRUST: SkillTrust = Object.freeze({ names: new Set<string>(), folders: Object.freeze([]) })

function canonical(path: string): string {
  try { return realpathSync.native(path) } catch { return resolve(path) }
}

/** Parse `skill_trust`: skill names, or folders given as absolute or `~/` paths. Invalid input trusts nothing. */
export function parseSkillTrust(value: unknown, home = homedir()): SkillTrust | string {
  if (value === undefined || value === null) return NO_SKILL_TRUST
  if (!Array.isArray(value) || value.length > MAX_ENTRIES || !value.every(entry => typeof entry === "string")) {
    return `skill_trust must be an array of at most ${MAX_ENTRIES} skill names or folder paths`
  }
  const names = new Set<string>()
  const folders: string[] = []
  for (const entry of value as string[]) {
    if (NAME.test(entry)) names.add(entry)
    else if (entry === "~" || entry.startsWith("~/")) folders.push(canonical(join(home, entry.slice(1))))
    else if (isAbsolute(entry)) folders.push(canonical(entry))
    else return `skill_trust entry ${JSON.stringify(entry.slice(0, 80))} is neither a skill name nor an absolute or ~/ folder`
  }
  return Object.freeze({ names, folders: Object.freeze(folders) })
}

/** Read trust from the user config file alone; a missing file trusts nothing, an unreadable one reports why. */
export function readSkillTrust(path = userConfigPath(), home = homedir()): SkillTrustLookup {
  let text: string
  try { text = readFileSync(path, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { trust: NO_SKILL_TRUST, source: path }
    return { trust: NO_SKILL_TRUST, problem: `${path} is unreadable`, source: path }
  }
  let parsed: unknown
  try { parsed = parseJsonc<unknown>(text) } catch {
    return { trust: NO_SKILL_TRUST, problem: `${path} is not valid JSONC`, source: path }
  }
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).skill_trust : undefined
  const trust = parseSkillTrust(value, home)
  return typeof trust === "string" ? { trust: NO_SKILL_TRUST, problem: trust, source: path } : { trust, source: path }
}

function within(folder: string, path: string): boolean {
  const offset = relative(folder, path)
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))
}

/** Whether an ordinary skill is trusted by name or by a folder containing its (resolved) directory. */
export function skillTrusted(trust: SkillTrust, roots: SkillRoots, descriptor: SkillDescriptor): boolean {
  if (descriptor.kind !== "skill") return false
  if (trust.names.has(descriptor.name)) return true
  if (!trust.folders.length) return false
  let directory: string
  try { directory = canonical(skillDirectoryPath(roots, descriptor)) } catch { return false }
  return trust.folders.some(folder => within(folder, directory))
}
