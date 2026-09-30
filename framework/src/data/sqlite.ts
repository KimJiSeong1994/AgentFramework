// sqlite backend for db_query: a python3 subprocess (stdlib sqlite3) per query. bun:sqlite cannot register scalar
// functions, and the fixture questions need `dist_m(lon1, lat1, lon2, lat2)` (haversine metres) as a stand-in for
// PostGIS. The helper opens the file `?mode=ro`, installs a SELECT/READ-only authorizer and a wall-clock timeout.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { QueryRows } from "./format.ts"

export type Backend = {
  dialect: "sqlite" | "postgres"
  query(sql: string, opts: { timeoutMs: number; maxRows?: number }): Promise<QueryRows>
  close(): void
}

export function sqliteHelperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "sqlite_query.py")
}

export function openSqlite(path: string, python = "python3"): Backend {
  if (!existsSync(path)) throw new Error(`sqlite file not found: ${path}`)
  const helper = sqliteHelperPath()
  return {
    dialect: "sqlite",
    query(sql, opts) {
      return new Promise<QueryRows>((resolve, reject) => {
        const child = spawn(python, [helper], { stdio: ["pipe", "pipe", "pipe"] })
        let out = ""
        let err = ""
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {}
        }, opts.timeoutMs + 2000)
        child.stdout.on("data", (c: Buffer) => (out += c.toString()))
        child.stderr.on("data", (c: Buffer) => (err += c.toString()))
        child.on("error", (e) => {
          clearTimeout(timer)
          reject(new Error(`sqlite helper failed to start (${python}): ${e.message}`))
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          if (code !== 0 && !out.trim()) return reject(new Error(err.trim().split("\n").pop() || `sqlite helper exited ${code}`))
          try {
            const parsed = JSON.parse(out) as { columns?: string[]; rows?: unknown[][]; error?: string }
            if (parsed.error) return reject(new Error(parsed.error))
            resolve({ columns: parsed.columns ?? [], rows: parsed.rows ?? [] })
          } catch (e) {
            reject(new Error(`sqlite helper returned invalid output: ${(e as Error).message}`))
          }
        })
        child.stdin.end(JSON.stringify({ path, sql, timeout_ms: opts.timeoutMs, max_rows: opts.maxRows ?? 201 }))
      })
    },
    close() {},
  }
}
