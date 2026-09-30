// One database backend per plugin instance, opened lazily (a missing file is reported at call time, not at startup).
// Shared by the `db_query` tool (analyst) and the queue's data-task pipeline (re-execution + checks).
import type { HookDeps } from "../hooks/types.ts"
import { openSqlite, type Backend } from "./sqlite.ts"
import { openPostgres } from "./postgres.ts"
import { resolvePath } from "./schema.ts"

const backends = new WeakMap<HookDeps, Backend>()

export function getBackend(deps: HookDeps): Backend {
  const cache = backends.get(deps)
  if (cache) return cache
  const d = deps.config.data
  let b: Backend
  if (d.backend === "sqlite") b = openSqlite(resolvePath(deps.worktree, d.sqlite_path), d.evo.python)
  else if (d.backend === "postgres") b = openPostgres({ dsnEnv: d.pg_dsn_env, allowRemote: d.pg_allow_remote, psql: d.psql_path })
  else throw new Error('lca: no database backend configured (data.backend is "none")')
  backends.set(deps, b)
  return b
}

export type { Backend }
