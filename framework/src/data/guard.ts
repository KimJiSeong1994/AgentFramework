// Read-only SQL guard for `db_query`. The model authors the SQL and it runs without a permission prompt, so this is
// belt (guard) and braces (BEGIN READ ONLY / sqlite readonly + authorizer): a single SELECT/WITH statement, no
// writes, no DDL, no server-side file/network functions, no PRAGMA/ATTACH, no multiple statements.

const FORBIDDEN_WORDS =
  /\b(insert|update|delete|merge|upsert|replace|drop|alter|create|truncate|grant|revoke|vacuum|analyze|reindex|copy|attach|detach|pragma|lock|call|do|execute|prepare|deallocate|listen|notify|refresh|cluster|comment|security|set|reset|show|explain)\b/i

const FORBIDDEN_FUNCS =
  /\b(load_extension|readfile|writefile|edit|fts5|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|dblink_exec|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|current_setting|pg_notify|xp_cmdshell|copy_from)\s*\(/i

/** Strip string literals and comments so keyword checks do not fire on data values. */
export function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
}

/** Why the SQL is refused, or null when it may run. */
export function sqlProblem(sql: string): string | null {
  const raw = sql.trim().replace(/;\s*$/, "")
  if (!raw) return "empty statement"
  const bare = stripLiterals(raw)
  if (bare.includes(";")) return "only one statement is allowed (no ';' inside the query)"
  if (!/^\s*(select|with)\b/i.test(bare)) return "only SELECT or WITH queries are allowed"
  const w = FORBIDDEN_WORDS.exec(bare)
  if (w) {
    // `set`/`do`/`call` etc. may legitimately appear inside identifiers only when quoted; the bare text has no quotes
    return `forbidden keyword: ${w[1]}`
  }
  const f = FORBIDDEN_FUNCS.exec(bare)
  if (f) return `forbidden function: ${f[1]}`
  if (/\binto\s+(?:temp|temporary|unlogged|table)?\s*\w/i.test(bare) && /\bselect\b[\s\S]*\binto\b/i.test(bare) && !/\binto\s+(?:outfile|dumpfile)/i.test(bare)) return "SELECT ... INTO is not allowed"
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(bare)) return "row locks are not allowed"
  return null
}

/** Ensure the query is bounded: append a LIMIT when there is none at the top level (very rough; the backend caps rows anyway). */
export function withLimit(sql: string, maxRows: number): string {
  const raw = sql.trim().replace(/;\s*$/, "")
  const bare = stripLiterals(raw)
  if (/\blimit\s+\d+/i.test(bare)) return raw
  return `${raw}\nLIMIT ${maxRows + 1}`
}
