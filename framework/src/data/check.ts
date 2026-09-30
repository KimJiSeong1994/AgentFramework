// Data-task verification (stage 3, second slice). The analyst's final message is a text contract (SQL: / RESULT: /
// ANSWER:). The framework never trusts RESULT: it extracts the SQL, re-executes it on the backend and runs a check
// suite over it — the data-side counterpart of the code-run `verify` command. Checks are SQL assertions with the
// answer query spliced in as `{answer}`; suites are JSON files under `data.checks_dir` (`<suite>.json`), plus the
// built-in `default` suite that every data task gets. Pass/fail lines only; the verifier agent reads them, it never
// runs anything itself (same reason the code reviewer has no bash: judges do not execute).
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Backend } from "./backend.ts"
import { sqlProblem, stripLiterals, withLimit } from "./guard.ts"
import { cell, type QueryRows } from "./format.ts"
import { resolvePath } from "./schema.ts"

export type CheckExpect = {
  /** at least / at most this many rows */
  rows_min?: number
  rows_max?: number
  /** first cell of the first row equals this (numbers compared numerically, strings exactly) */
  value?: string | number | boolean | null
  /** first cell of the first row is numeric and within [value_min, value_max] */
  value_min?: number
  value_max?: number
  /** no NULL in the first column */
  not_null?: boolean
  /** the answer SQL (literals stripped, lower-cased) must / must not contain this text */
  sql_contains?: string
  sql_not_contains?: string
}

export type Check = { name: string; sql?: string; expect: CheckExpect }
export type CheckSuite = { name: string; checks: Check[] }
export type CheckResult = { name: string; ok: boolean; detail: string }
export type CheckRun = { suite: string; ok: boolean; results: CheckResult[]; rows?: QueryRows; error?: string }

export const SUITE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Built-in suite: the answer query runs, returns something, and a scalar answer is not NULL. */
export const DEFAULT_SUITE: CheckSuite = {
  name: "default",
  checks: [
    { name: "answer runs", expect: {} },
    { name: "answer has rows", expect: { rows_min: 1 } },
    { name: "answer is not NULL", expect: { not_null: true } },
  ],
}

export function suitePath(worktree: string, checksDir: string, name: string): string {
  return join(resolvePath(worktree, checksDir), `${name}.json`)
}

/** Why a suite name cannot be used for a data task, or null. `default` always exists. */
export function suiteProblem(worktree: string, checksDir: string, name: string): string | null {
  if (!SUITE_NAME_RE.test(name)) return `check suite name must match ${SUITE_NAME_RE.source}`
  if (name === DEFAULT_SUITE.name) return null
  const p = suitePath(worktree, checksDir, name)
  if (!existsSync(p)) return `check suite not found: ${p}`
  try {
    loadSuite(worktree, checksDir, name)
  } catch (e) {
    return `check suite invalid: ${(e as Error).message}`
  }
  return null
}

export function loadSuite(worktree: string, checksDir: string, name: string): CheckSuite {
  if (name === DEFAULT_SUITE.name) return DEFAULT_SUITE
  const raw = JSON.parse(readFileSync(suitePath(worktree, checksDir, name), "utf8")) as { checks?: unknown }
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) throw new Error("no checks[]")
  const checks: Check[] = raw.checks.map((c: any, i: number) => {
    if (!c || typeof c !== "object" || typeof c.name !== "string") throw new Error(`checks[${i}] needs a name`)
    if (c.sql !== undefined && typeof c.sql !== "string") throw new Error(`checks[${i}].sql must be a string`)
    if (c.sql && !c.sql.includes("{answer}")) throw new Error(`checks[${i}].sql must reference {answer}`)
    return { name: c.name, sql: c.sql, expect: (c.expect ?? {}) as CheckExpect }
  })
  return { name, checks }
}

/**
 * The analyst's output contract: `SQL:` block (optionally fenced), `RESULT:` block, `ANSWER:` line. Returns what was
 * found; a missing SQL block is the caller's failure signal.
 */
export function extractAnswer(text: string): { sql?: string; result?: string; answer?: string } {
  const out: { sql?: string; result?: string; answer?: string } = {}
  const sqlM = /(?:^|\n)\s*(?:\*\*)?SQL(?:\*\*)?\s*:?\s*(?:\*\*)?\s*\n?\s*(?:```(?:sql)?\s*)?([\s\S]*?)\s*(?:```\s*)?(?=\n\s*(?:\*\*)?(?:RESULT|ANSWER)(?:\*\*)?\s*:|$)/i.exec(text)
  if (sqlM && sqlM[1]?.trim()) out.sql = sqlM[1].trim().replace(/```\s*$/, "").trim()
  const resM = /(?:^|\n)\s*(?:\*\*)?RESULT(?:\*\*)?\s*:\s*(?:\*\*)?\s*\n?([\s\S]*?)(?=\n\s*(?:\*\*)?ANSWER(?:\*\*)?\s*:|$)/i.exec(text)
  if (resM && resM[1]?.trim()) out.result = resM[1].trim().replace(/^```[a-z]*\s*|\s*```$/g, "").trim()
  const ansM = /(?:^|\n)\s*(?:\*\*)?ANSWER(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n]+)/i.exec(text)
  if (ansM && ansM[1]?.trim()) out.answer = ansM[1].trim()
  return out
}

function firstCell(rows: QueryRows): unknown {
  return rows.rows[0]?.[0]
}

function numeric(v: unknown): number | null {
  if (typeof v === "number") return v
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v)
  return null
}

function judge(expect: CheckExpect, rows: QueryRows | null, answerSql: string): string | null {
  const bare = stripLiterals(answerSql).toLowerCase()
  if (expect.sql_contains !== undefined && !bare.includes(expect.sql_contains.toLowerCase())) return `SQL does not mention "${expect.sql_contains}"`
  if (expect.sql_not_contains !== undefined && bare.includes(expect.sql_not_contains.toLowerCase())) return `SQL must not mention "${expect.sql_not_contains}"`
  if (!rows) return null
  const n = rows.rows.length
  if (expect.rows_min !== undefined && n < expect.rows_min) return `${n} row(s), expected at least ${expect.rows_min}`
  if (expect.rows_max !== undefined && n > expect.rows_max) return `${n} row(s), expected at most ${expect.rows_max}`
  const v = firstCell(rows)
  if (expect.not_null && (n === 0 || v === null || v === undefined)) return "first value is NULL"
  if (expect.value !== undefined) {
    const want = expect.value
    const a = numeric(v)
    const b = numeric(want)
    const same = a !== null && b !== null ? a === b : String(v) === String(want)
    if (!same) return `value ${cell(v, 40)}, expected ${cell(want, 40)}`
  }
  if (expect.value_min !== undefined || expect.value_max !== undefined) {
    const a = numeric(v)
    if (a === null) return `value ${cell(v, 40)} is not numeric`
    if (expect.value_min !== undefined && a < expect.value_min) return `value ${a} < ${expect.value_min}`
    if (expect.value_max !== undefined && a > expect.value_max) return `value ${a} > ${expect.value_max}`
  }
  return null
}

/**
 * Run a suite against the answer SQL. The answer itself is executed once (its rows come back for the verifier and the
 * handoff); each check with its own `sql` runs `{answer}` spliced in as a subquery. A guard refusal or execution error
 * of the answer fails every check.
 */
export async function runChecks(
  backend: Backend,
  answerSql: string,
  suites: CheckSuite[],
  opts: { timeoutMs: number; maxRows: number },
): Promise<CheckRun> {
  const name = suites.map((s) => s.name).join("+")
  const results: CheckResult[] = []
  const problem = sqlProblem(answerSql)
  if (problem) return { suite: name, ok: false, results: suites.flatMap((s) => s.checks.map((c) => ({ name: c.name, ok: false, detail: `answer SQL refused: ${problem}` }))), error: `answer SQL refused: ${problem}` }
  let rows: QueryRows
  try {
    rows = await backend.query(withLimit(answerSql, opts.maxRows), { timeoutMs: opts.timeoutMs, maxRows: opts.maxRows + 1 })
  } catch (e) {
    const msg = `answer SQL failed: ${(e as Error).message.slice(0, 300)}`
    return { suite: name, ok: false, results: suites.flatMap((s) => s.checks.map((c) => ({ name: c.name, ok: false, detail: msg }))), error: msg }
  }
  const inner = answerSql.trim().replace(/;\s*$/, "")
  for (const suite of suites) {
    for (const c of suite.checks) {
      let target: QueryRows | null = rows
      if (c.sql) {
        const sql = c.sql.replace(/\{answer\}/g, `(${inner})`)
        const p = sqlProblem(sql)
        if (p) {
          results.push({ name: c.name, ok: false, detail: `check SQL refused: ${p}` })
          continue
        }
        try {
          target = await backend.query(withLimit(sql, opts.maxRows), { timeoutMs: opts.timeoutMs, maxRows: opts.maxRows + 1 })
        } catch (e) {
          results.push({ name: c.name, ok: false, detail: `check SQL failed: ${(e as Error).message.slice(0, 200)}` })
          continue
        }
      }
      const why = judge(c.expect, target, answerSql)
      results.push({ name: c.name, ok: !why, detail: why ?? "ok" })
    }
  }
  return { suite: name, ok: results.every((r) => r.ok), results, rows }
}

/** One line per check, for the ledger/handoff/verifier prompt. */
export function formatCheckRun(run: CheckRun): string {
  const lines = run.results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : `: ${r.detail}`}`)
  if (run.error && lines.length === 0) lines.push(`FAIL ${run.error}`)
  return lines.join("\n")
}

/** ≤ maxRows rows as a tab table for the verifier prompt / handoff. */
export function sampleRows(rows: QueryRows | undefined, maxRows: number, maxCell = 60): string {
  if (!rows) return "(not executed)"
  const lines = [rows.columns.join("\t"), ...rows.rows.slice(0, maxRows).map((r) => r.map((v) => cell(v, maxCell)).join("\t"))]
  const total = rows.rows.length
  lines.push(`-- ${total === 0 ? "0 rows" : total > maxRows ? `${maxRows} of ${total}+ rows` : `${total} row${total === 1 ? "" : "s"}`}`)
  return lines.join("\n")
}
