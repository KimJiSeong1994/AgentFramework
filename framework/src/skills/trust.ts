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
/**
 * `skill_auto` (user config only): in `otter chat`, `auto` (default) lists consent-free skills to the main model, which
 * loads them with the `skill` tool as the conversation calls for them; `off` offers none. `include` admits import-tier
 * (Claude/Codex convention) skills by name, `exclude` removes any skill by name. A project config cannot widen this.
 */
export type SkillAutoMode = "off" | "auto"
export type SkillAutoPolicy = Readonly<{ mode: SkillAutoMode; include: ReadonlySet<string>; exclude: ReadonlySet<string> }>
export type SkillTrustLookup = Readonly<{ trust: SkillTrust; auto: SkillAutoPolicy; problem?: string; source: string }>

export const NO_SKILL_TRUST: SkillTrust = Object.freeze({ names: new Set<string>(), folders: Object.freeze([]) })
export const DEFAULT_SKILL_AUTO: SkillAutoPolicy = Object.freeze({ mode: "auto", include: new Set<string>(), exclude: new Set<string>() })
const OFF_SKILL_AUTO: SkillAutoPolicy = Object.freeze({ mode: "off", include: new Set<string>(), exclude: new Set<string>() })

function nameSet(value: unknown, key: string): Set<string> | string {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.length > MAX_ENTRIES || !value.every(entry => typeof entry === "string" && NAME.test(entry))) {
    return `skill_auto.${key} must be an array of at most ${MAX_ENTRIES} skill names`
  }
  return new Set(value as string[])
}

/** Parse `skill_auto`. Absent means the default (auto); any invalid field disables it rather than guessing. */
export function parseSkillAuto(value: unknown): SkillAutoPolicy | string {
  if (value === undefined || value === null) return DEFAULT_SKILL_AUTO
  if (typeof value !== "object" || Array.isArray(value)) return "skill_auto must be an object"
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !["mode", "include", "exclude"].includes(key))
  if (unknown.length) return `skill_auto has unknown key ${JSON.stringify(unknown[0]!.slice(0, 40))}`
  const mode = record.mode ?? DEFAULT_SKILL_AUTO.mode
  if (mode !== "off" && mode !== "auto") return "skill_auto.mode must be off or auto"
  const include = nameSet(record.include, "include")
  if (typeof include === "string") return include
  const exclude = nameSet(record.exclude, "exclude")
  if (typeof exclude === "string") return exclude
  return Object.freeze({ mode, include, exclude })
}

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

/**
 * Read trust and the auto-selection policy from the user config file alone. A missing file trusts nothing and keeps the
 * default auto mode; an unreadable or invalid file trusts nothing, disables auto selection and reports why.
 */
export function readSkillTrust(path = userConfigPath(), home = homedir()): SkillTrustLookup {
  let text: string
  try { text = readFileSync(path, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { trust: NO_SKILL_TRUST, auto: DEFAULT_SKILL_AUTO, source: path }
    return { trust: NO_SKILL_TRUST, auto: OFF_SKILL_AUTO, problem: `${path} is unreadable`, source: path }
  }
  let parsed: unknown
  try { parsed = parseJsonc<unknown>(text) } catch {
    return { trust: NO_SKILL_TRUST, auto: OFF_SKILL_AUTO, problem: `${path} is not valid JSONC`, source: path }
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  const trust = parseSkillTrust(record.skill_trust, home)
  const auto = parseSkillAuto(record.skill_auto)
  const problems = [trust, auto].filter((item): item is string => typeof item === "string")
  return {
    trust: typeof trust === "string" ? NO_SKILL_TRUST : trust,
    auto: typeof auto === "string" ? OFF_SKILL_AUTO : auto,
    ...(problems.length ? { problem: problems.join("; ") } : {}),
    source: path,
  }
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
