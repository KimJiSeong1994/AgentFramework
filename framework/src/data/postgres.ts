// postgres backend for db_query: psql subprocess (no driver dependency), every query wrapped in a READ ONLY
// transaction with a statement timeout. The DSN comes only from an environment variable and must point at loopback
// unless `pg_allow_remote` is set (the handover database is a production server with a superuser account).
import { spawn } from "node:child_process"
import type { Backend } from "./sqlite.ts"
import type { QueryRows } from "./format.ts"

export function dsnHost(dsn: string): string | null {
  try {
    const u = new URL(dsn)
    return u.hostname || null
  } catch {
    const m = /host=([^\s]+)/.exec(dsn)
    return m ? m[1]! : null
  }
}

export function isLoopback(host: string | null): boolean {
  if (!host) return true // unix socket / default
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("/")
}

export function openPostgres(opts: { dsnEnv: string; allowRemote: boolean; psql: string }): Backend {
  const dsn = process.env[opts.dsnEnv]
  if (!dsn) throw new Error(`postgres backend: environment variable ${opts.dsnEnv} is not set`)
  const host = dsnHost(dsn)
  if (!opts.allowRemote && !isLoopback(host)) throw new Error(`postgres backend: host "${host}" is not loopback; set data.pg_allow_remote to use a remote database on purpose`)
  return {
    dialect: "postgres",
    query(sql, q) {
      return new Promise<QueryRows>((resolve, reject) => {
        const script = `BEGIN READ ONLY;\nSET LOCAL statement_timeout = ${Math.max(1000, q.timeoutMs)};\n${sql.trim().replace(/;\s*$/, "")};\nCOMMIT;`
        const child = spawn(opts.psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-d", dsn], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PGCONNECT_TIMEOUT: "5" } })
        let out = ""
        let err = ""
        child.stdout.on("data", (c: Buffer) => (out += c.toString()))
        child.stderr.on("data", (c: Buffer) => (err += c.toString()))
        child.on("error", (e) => reject(new Error(`psql failed to start: ${e.message}`)))
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.replace(dsn, "<dsn>").trim() || `psql exited ${code}`))
          resolve(parseCsv(out))
        })
        child.stdin.end(script)
      })
    },
    close() {},
  }
}

/** Minimal RFC4180 parser for psql --csv output (BEGIN/SET/COMMIT print nothing with -q). */
export function parseCsv(text: string): QueryRows {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (ch !== "\r") field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return { columns: [], rows: [] }
  const [header, ...body] = rows
  return { columns: header!, rows: body.filter((r) => r.length === header!.length) }
}
