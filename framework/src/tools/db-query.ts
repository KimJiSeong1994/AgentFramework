// `db_query` tool (data-analyst only): one read-only SELECT/WITH statement against the configured backend, result
// trimmed to rows / cell width / estimated tokens with a hint line. The SQL guard + read-only transaction/handle make
// writes impossible; a per-session call cap stops a looping model. Errors come back as tool errors (the model reads
// the message and fixes the query; the repeat guard blocks identical retries).
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { HookDeps } from "../hooks/types.ts"
import { sqlProblem, withLimit } from "../data/guard.ts"
import { formatRows } from "../data/format.ts"
import { getBackend } from "../data/backend.ts"

export const DB_QUERY_DESCRIPTION =
  "Run one read-only SQL query (SELECT or WITH only) against the project database and get up to 50 rows back. " +
  "Use schema_lookup or resolve_semantics first; never guess column names. Aggregate instead of listing rows."

export const DATA_AGENTS: ReadonlySet<string> = new Set(["data-analyst", "data-verifier"])

const z = tool.schema

const callsPerSession = new Map<string, number>()

export function createDbQueryTool(deps: HookDeps): ToolDefinition {
  return tool({
    description: DB_QUERY_DESCRIPTION,
    args: {
      sql: z.string().min(1).max(4000).describe("one SELECT or WITH statement"),
      max_rows: z.number().int().min(1).max(200).optional().describe("row cap (default 50)"),
    },
    async execute(args, ctx) {
      if (ctx.agent && !DATA_AGENTS.has(ctx.agent)) throw new Error(`lca: db_query is only available to the data agents (current agent: ${ctx.agent}).`)
      const d = deps.config.data
      const problem = sqlProblem(args.sql)
      if (problem) throw new Error(`lca: query refused — ${problem}. Write a single SELECT/WITH statement.`)
      // only queries that reach the database count towards the cap (refusals cost nothing)
      const n = (callsPerSession.get(ctx.sessionID) ?? 0) + 1
      if (n > d.max_queries_per_session) throw new Error(`lca: db_query limit (${d.max_queries_per_session} per session) reached. Answer with what you have.`)
      callsPerSession.set(ctx.sessionID, n)
      const maxRows = Math.min(args.max_rows ?? d.max_rows, d.max_rows * 4)
      const backend = getBackend(deps)
      const sql = withLimit(args.sql, maxRows)
      const t0 = Date.now()
      let res
      try {
        res = await backend.query(sql, { timeoutMs: d.statement_timeout_ms, maxRows: maxRows + 1 })
      } catch (e) {
        const msg = (e as Error).message
        deps.log("db_query error", { sessionID: ctx.sessionID, error: msg.slice(0, 200) })
        throw new Error(`lca: query failed — ${msg.slice(0, 400)}. Fix the SQL (check schema_lookup for exact column names); do not repeat the same query.`)
      }
      const elapsedMs = Date.now() - t0
      const text = formatRows(res, { maxRows, maxCell: d.max_cell_chars, maxTokens: d.max_output_tokens, elapsedMs })
      deps.log("db_query", { sessionID: ctx.sessionID, rows: res.rows.length, ms: elapsedMs, call: n })
      return { title: `db_query: ${res.rows.length} row(s)`, output: text, metadata: { rows: res.rows.length, ms: elapsedMs, call: n } }
    },
  })
}

/** test hook */
export function _resetDbQueryCounts(): void {
  callsPerSession.clear()
}
