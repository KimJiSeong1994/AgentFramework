// `schema_lookup` tool (data agents only): columns/types/notes of ONE table from the project's static schema file,
// or the table list when no table is given. Never a catalog dump (prefix discipline: the schema is ~5K est. tokens).
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { HookDeps } from "../hooks/types.ts"
import { describeTable, loadSchema, tableList } from "../data/schema.ts"
import { DATA_AGENTS } from "./db-query.ts"

export const SCHEMA_LOOKUP_DESCRIPTION =
  "Columns, types and meaning of one database table (or the table list when no table is given). Call it once per table you need; never guess columns."

const z = tool.schema

export function createSchemaLookupTool(deps: HookDeps): ToolDefinition {
  return tool({
    description: SCHEMA_LOOKUP_DESCRIPTION,
    args: { table: z.string().max(120).optional().describe("table name; omit for the list") },
    async execute(args, ctx) {
      if (ctx.agent && !DATA_AGENTS.has(ctx.agent)) throw new Error(`lca: schema_lookup is only available to the data agents (current agent: ${ctx.agent}).`)
      const schema = loadSchema(deps.worktree, deps.config.data.schema_file)
      if (!schema) throw new Error(`lca: schema file ${deps.config.data.schema_file} not found in the worktree; generate it with scripts/lca-schema-extract.py`)
      const text = args.table ? describeTable(schema, args.table.trim()) : tableList(schema)
      return { title: args.table ? `schema: ${args.table}` : "schema: tables", output: text }
    },
  })
}
