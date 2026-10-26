import { buildRepoSearchIndex } from "./store.ts"
import { normalizeRepoSearchRoots } from "./corpus.ts"

export type BuildCliArguments = Readonly<{ approve: true; roots: readonly string[] }>

export function parseBuildCliArguments(args: readonly string[]): BuildCliArguments {
  let approved = false
  const roots: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === "--approve") {
      if (approved) throw new Error("repo_search_duplicate_approval")
      approved = true
    } else if (argument === "--root") {
      const root = args[++index]
      if (!root || root.startsWith("--")) throw new Error("Usage: bun run src/repo-search/build-cli.ts --approve --root <repo-relative-directory> [--root <directory> ...]")
      roots.push(root)
    } else {
      throw new Error("Usage: bun run src/repo-search/build-cli.ts --approve --root <repo-relative-directory> [--root <directory> ...]")
    }
  }
  if (!approved) throw new Error("repo_search_approval_required")
  return Object.freeze({ approve: true, roots: Object.freeze(normalizeRepoSearchRoots(roots)) })
}

export async function runBuildCli(args: readonly string[], worktree = process.cwd()): Promise<void> {
  const parsed = parseBuildCliArguments(args)
  console.log("Approval disclosure: this command indexes only the explicit roots below, locally. Search references may be added to model context and sent to a configured cloud model by the host.")
  console.log(`Approved roots: ${parsed.roots.join(", ")}`)
  await buildRepoSearchIndex(worktree, parsed.roots, { approve: true })
  console.log("Repository search index built and approved for this worktree.")
}

if (import.meta.main) {
  try { await runBuildCli(process.argv.slice(2)) }
  catch (error) {
    console.error(error instanceof Error ? error.message : "repo_search_build_failed")
    process.exitCode = 1
  }
}
