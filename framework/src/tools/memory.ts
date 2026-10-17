// `memory` tool (main + read-only planning roles): an inference engine links the request to knowledge/wiki pages.
// Read-only; the result is reference data. Writing memory is capture/register + the llm-wiki ingest flow.
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { HookDeps } from "../hooks/types.ts"
import { currentMemoryConfig, MEMORY_DESCRIPTION, memoryToolText } from "../wiki/recall.ts"

const z = tool.schema

export function createMemoryTool(deps: HookDeps): ToolDefinition {
  return tool({
    description: MEMORY_DESCRIPTION,
    args: { query: z.string().min(1).max(2000).describe("the request or question in your own words") },
    async execute(args, ctx) {
      const output = await memoryToolText(deps.worktree, args.query, currentMemoryConfig(deps.worktree), ctx.abort, { prefetchSession: ctx.sessionID })
      return { title: `memory: ${args.query.trim().slice(0, 60)}`, output }
    },
  })
}
