import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { z } from "zod"
import type { HookDeps } from "../hooks/types.ts"

export type SkillCandidate = { name: string; description: string }
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const ruleSchema = z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "deny", "ask"]) })
const metadataSchema = z.object({ name: z.string(), description: z.string().trim().min(1).max(800) })

// OpenCode's normalized permission rules are ordered, last matching rule wins.
// Unsupported patterns abstain rather than guessing permission semantics.
function permitted(rules: z.infer<typeof ruleSchema>[], name: string): boolean {
  let action = "ask"
  for (const rule of rules) {
    if (!/^[a-zA-Z0-9_.*?-]+$/.test(rule.permission)) return false
    if (!new Bun.Glob(rule.permission).match("skill")) continue
    if (!/^[a-zA-Z0-9_.*?-]+$/.test(rule.pattern)) return false
    if (new Bun.Glob(rule.pattern).match(name)) action = rule.action
  }
  return action === "allow"
}

/** Project catalog only; global/external skills and symlinks escaping the worktree are not sent to inference. */
export async function availableCandidates(deps: HookDeps, signal: AbortSignal): Promise<SkillCandidate[]> {
  const response = await deps.client.app.agents({ query: { directory: deps.directory }, signal })
  if (response.error || !Array.isArray(response.data)) return []
  const main = response.data.find((agent) => agent.name === "main")
  if (!main || (main as unknown as { tools?: { skill?: boolean } }).tools?.skill === false) return []
  const parsed = z.array(ruleSchema).safeParse(main.permission)
  if (!parsed.success) return []
  const root = await realpath(deps.worktree)
  const result: SkillCandidate[] = []
  const names = [...new Set(deps.config.skills.allow)].filter((name) => NAME.test(name) && name !== "none")
  // No truncation: a larger catalog needs an explicitly evaluated retrieval strategy.
  if (names.length > 16) return []
  for (const name of names) {
    if (signal.aborted) return []
    if (!permitted(parsed.data, name)) continue
    const [inOpencode, inAgents] = await Promise.all(SKILL_ROOTS.map((root2) => skillFilePresent(root, root2, name)))
    // Both roots define the same skill name: ambiguous, exclude rather than guess which wins.
    if (inOpencode && inAgents) continue
    const skillRoot = inOpencode ? SKILL_ROOTS[0] : inAgents ? SKILL_ROOTS[1] : undefined
    if (!skillRoot) continue
    try {
      const candidate = await loadSkillCandidate(root, skillRoot, name)
      if (candidate) result.push(candidate)
    } catch {
      // A missing/invalid local skill is not an available candidate.
    }
  }
  return result
}

/** Checked in order: .opencode/skills first, .agents/skills as fallback. Both defining the same name is ambiguous. */
const SKILL_ROOTS = [".opencode", ".agents"] as const

async function skillFilePresent(root: string, base: string, name: string): Promise<boolean> {
  try {
    await stat(join(root, base, "skills", name, "SKILL.md"))
    return true
  } catch {
    return false
  }
}

async function loadSkillCandidate(root: string, base: string, name: string): Promise<SkillCandidate | null> {
  const path = await realpath(join(root, base, "skills", name, "SKILL.md"))
  const rel = relative(root, path)
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return null
  const info = await stat(path)
  if (!info.isFile() || info.size > 16384) return null
  const content = await readFile(path, "utf8")
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!frontmatter) return null
  const metadata = metadataSchema.safeParse(Bun.YAML.parse(frontmatter[1]!))
  if (!metadata.success || metadata.data.name !== name) return null
  return { name, description: metadata.data.description }
}
