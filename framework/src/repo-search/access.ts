import { createGraphRuntime, type GraphRuntime } from "./runtime.ts"
import { queryRepoSearch, repoSearchHasApprovedIndex } from "./store.ts"

const PUBLIC_FAILURES = new Set([
  "repo_search_missing_artifact", "repo_search_corrupt_manifest", "repo_search_corrupt_artifact",
  "repo_search_identity_mismatch", "repo_search_stale", "repo_search_runtime_mismatch",
  "repo_search_index_changed", "repo_search_cancelled", "repo_search_invalid_query",
  "repo_search_invalid_limit", "repo_search_invalid_hit", "repo_search_output_limit",
])

export function repoSearchAvailable(worktree: string): boolean {
  return repoSearchHasApprovedIndex(worktree)
}

export function createRepoSearchProvider(
  worktree: string,
): ((input: { query: string; limit?: number }, signal?: AbortSignal) => Promise<string>) | undefined {
  if (!repoSearchAvailable(worktree)) return undefined
  let runtime: GraphRuntime | undefined
  return async (input, signal) => {
    try {
      if (signal?.aborted) throw new Error("repo_search_cancelled")
      runtime ??= createGraphRuntime()
      return await queryRepoSearch(worktree, runtime, input, signal)
    } catch (error) {
      const code = error instanceof Error ? error.message : ""
      throw new Error(PUBLIC_FAILURES.has(code) ? code : "repo_search_unavailable")
    }
  }
}
