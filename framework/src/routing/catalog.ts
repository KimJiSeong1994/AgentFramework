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
    try {
      const path = await realpath(join(root, ".opencode", "skills", name, "SKILL.md"))
      const rel = relative(root, path)
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) continue
      const info = await stat(path)
      if (!info.isFile() || info.size > 16384) continue
      const content = await readFile(path, "utf8")
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
      if (!frontmatter) continue
      const metadata = metadataSchema.safeParse(Bun.YAML.parse(frontmatter[1]!))
      if (!metadata.success || metadata.data.name !== name) continue
      result.push({ name, description: metadata.data.description })
    } catch {
      // A missing/invalid local skill is not an available candidate.
    }
  }
  return result
}
