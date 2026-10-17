// Stage 3, second slice: data tasks through the delegate queue. Answer contract extraction, check suites on the sqlite
// fixture, the queue's data path (analyst child -> re-execution + checks -> verifier verdict -> ledger/handoff),
// delegate validation of kind:"data", main prompt / data mode wiring.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { DEFAULT_SUITE, extractAnswer, formatCheckRun, loadSuite, runChecks, sampleRows, suiteProblem } from "../src/data/check.ts"
import { openSqlite } from "../src/data/sqlite.ts"
import { analystPrompt, createQueue, verifierPrompt } from "../src/orchestration/queue.ts"
import { createDelegateTool, DELEGATE_DESCRIPTION, delegateArgs } from "../src/tools/delegate.ts"
import { readLedger, summarizeLedger } from "../src/state/ledger.ts"
import { ANSWER_JUDGE_PROMPT, DATA_VERIFIER_PROMPT, MAIN_RULE_DATA, ONTOLOGY_EVOLVER_PROMPT, mainPrompt } from "../src/agents/prompts.ts"
import { MODE_INSTRUCTIONS, MODE_INSTRUCTIONS_NO_DELEGATE } from "../src/modes/instructions.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { estimateTokens, estimateToolSchemaTokens } from "../src/tokens.ts"
import { fakeClient, makeDeps, tempGitWorktree, type FakeClient } from "./guards-helpers.ts"
import { fakeDeps } from "./helpers.ts"

const FIXTURE = join(import.meta.dir, "..", "..", "scripts", "fixtures", "data-vv")
const DB = join(FIXTURE, "data", "vehicle_visit.sqlite")
const S = "ses_main"

let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient({ promptAsync: true })
  if (!existsSync(DB)) execFileSync("python3", [join(FIXTURE, "make_fixture.py")], { stdio: "pipe" })
})
afterEach(() => wt.cleanup())

const dataCfg = (over: Record<string, unknown> = {}) =>
  ({ data: { backend: "sqlite", sqlite_path: DB, schema_file: join(FIXTURE, "data", "schema.json"), checks_dir: "checks", evo: { enabled: true, workspace: join(FIXTURE, ".evoontology"), python: "python3", server: "" }, ...over } } as any)
const prompts = (agent: string) => client.calls.filter((c) => c.method === "prompt" && (c.args as any).body.agent === agent).map((c) => (c.args as any).body.parts[0].text as string)
const GOOD_SQL = "SELECT count(*) AS farm_count FROM tb_place_info WHERE place_type = 'farm' AND sido = '경기'"
const answer = (sql: string, ans = "경기 농장은 22개입니다.") => `SQL:\n${sql}\nRESULT:\n22\nANSWER: ${ans}`
const writeSuite = (name: string, checks: unknown[]) => {
  mkdirSync(join(wt.worktree, "checks"), { recursive: true })
  writeFileSync(join(wt.worktree, "checks", `${name}.json`), JSON.stringify({ checks }))
}

describe("answer contract", () => {
  test("extractAnswer reads SQL / RESULT / ANSWER with and without fences or bold", () => {
    const a = extractAnswer("SQL:\n```sql\nSELECT 1 AS x\n```\nRESULT:\n1\nANSWER: one.")
    expect(a).toEqual({ sql: "SELECT 1 AS x", result: "1", answer: "one." })
    const b = extractAnswer("**SQL:**\nSELECT count(*) FROM t\nWHERE a = 1\n**RESULT:**\nx\ty\n1\t2\n**ANSWER:** two rows")
    expect(b.sql).toBe("SELECT count(*) FROM t\nWHERE a = 1")
    expect(b.result).toBe("x\ty\n1\t2")
    expect(b.answer).toBe("two rows")
    expect(extractAnswer("ANSWER: the data cannot answer this.")).toEqual({ answer: "the data cannot answer this." })
    expect(extractAnswer("I looked at the tables.")).toEqual({})
  })
})

describe("check suites on the sqlite fixture", () => {
  test("default suite passes on a real answer and fails on refused / broken / empty SQL", async () => {
    const backend = openSqlite(DB)
    const ok = await runChecks(backend, GOOD_SQL, [DEFAULT_SUITE], { timeoutMs: 5000, maxRows: 50 })
    expect(ok.ok).toBe(true)
    expect(ok.results.map((r) => r.ok)).toEqual([true, true, true])
    expect(ok.rows?.rows[0]?.[0]).toBe(22)
    expect(sampleRows(ok.rows, 10)).toContain("farm_count\n22\n-- 1 row")

    const refused = await runChecks(backend, "DELETE FROM tb_place_info", [DEFAULT_SUITE], { timeoutMs: 5000, maxRows: 50 })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/refused/)
    const broken = await runChecks(backend, "SELECT nope FROM tb_place_info", [DEFAULT_SUITE], { timeoutMs: 5000, maxRows: 50 })
    expect(broken.ok).toBe(false)
    expect(formatCheckRun(broken)).toMatch(/FAIL answer runs: answer SQL failed/)
    const empty = await runChecks(backend, "SELECT place_id FROM tb_place_info WHERE sido = 'nowhere'", [DEFAULT_SUITE], { timeoutMs: 5000, maxRows: 50 })
    expect(empty.results.map((r) => r.ok)).toEqual([true, false, false])
    const nul = await runChecks(backend, "SELECT max(place_id) FROM tb_place_info WHERE sido = 'nowhere'", [DEFAULT_SUITE], { timeoutMs: 5000, maxRows: 50 })
    expect(nul.results.map((r) => r.ok)).toEqual([true, true, false])
  })

  test("named suite: {answer} is spliced as a subquery; value/rows/sql expectations are judged", async () => {
    const backend = openSqlite(DB)
    writeSuite("farms", [
      { name: "one row", sql: "SELECT count(*) FROM {answer} a", expect: { value: 1 } },
      { name: "positive", expect: { value_min: 1, value_max: 10000 } },
      { name: "farm filter", expect: { sql_contains: "place_type" } },
      { name: "no visit table", expect: { sql_not_contains: "tb_visit_history" } },
      { name: "exact 22", expect: { value: "22" } },
    ])
    expect(suiteProblem(wt.worktree, "checks", "farms")).toBeNull()
    expect(suiteProblem(wt.worktree, "checks", "missing")).toMatch(/not found/)
    expect(suiteProblem(wt.worktree, "checks", "../etc")).toMatch(/must match/)
    writeSuite("bad", [{ name: "x", sql: "SELECT 1" }])
    expect(suiteProblem(wt.worktree, "checks", "bad")).toMatch(/reference \{answer\}/)
    const suite = loadSuite(wt.worktree, "checks", "farms")
    const run = await runChecks(backend, GOOD_SQL, [DEFAULT_SUITE, suite], { timeoutMs: 5000, maxRows: 50 })
    expect(run.ok).toBe(true)
    expect(run.suite).toBe("default+farms")
    const wrong = await runChecks(backend, GOOD_SQL.replace("22", "22").replace("count(*)", "count(*) + 1"), [suite], { timeoutMs: 5000, maxRows: 50 })
    expect(wrong.results.find((r) => r.name === "exact 22")).toMatchObject({ ok: false, detail: "value 23, expected 22" })
    // a check with its own SQL must be read-only too
    writeSuite("evil", [{ name: "w", sql: "DELETE FROM tb_place_info WHERE place_id IN (SELECT * FROM {answer})", expect: {} }])
    const evil = await runChecks(backend, GOOD_SQL, [loadSuite(wt.worktree, "checks", "evil")], { timeoutMs: 5000, maxRows: 50 })
    expect(evil.results[0]).toMatchObject({ ok: false })
    expect(evil.results[0]!.detail).toMatch(/check SQL refused/)
  })
})

describe("queue: data tasks", () => {
  test("analyst child -> SQL re-executed + default checks -> verifier ACCEPT -> done with answer; no snapshot, no files", async () => {
    const deps = makeDeps(client, wt.worktree, dataCfg())
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies["data-analyst"] = { texts: ["calling tools…", answer(GOOD_SQL)] }
    client.replies["data-verifier"] = { text: "1. yes\n2. yes\n3. yes\nACCEPT" }
    q.add(S, [{ title: "경기 농장 수 알려줘", kind: "data" }])
    const run = await q.run(S)
    expect(run).toMatchObject({ done: 1, failed: 0, aborted: false })
    expect(run.noSnapshot).toBeUndefined()
    expect(client.created.map((c) => c.title)).toEqual(["otter data 1: 경기 농장 수 알려줘", "otter verify 1: 경기 농장 수 알려줘"])
    expect(prompts("data-analyst")[0]).toBe("Question: 경기 농장 수 알려줘")
    const v = prompts("data-verifier")[0]!
    expect(v).toContain("SQL:\n" + GOOD_SQL)
    expect(v).toContain("farm_count\n22")
    expect(v).toContain("Checks (default):\nPASS answer runs\nPASS answer has rows\nPASS answer is not NULL")
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t).toMatchObject({ status: "done", kind: "data", sql: GOOD_SQL, answer: "경기 농장은 22개입니다.", attempts: 1 })
    expect(t.filesChanged).toBeUndefined()
    expect(t.verify_result).toMatchObject({ command: "data_check default", ok: true, exitCode: 0 })
    expect(t.review?.verdict).toBe("accept")
    const handoff = readFileSync(join(wt.worktree, t.handoff!), "utf8")
    expect(handoff).toContain("- answer: 경기 농장은 22개입니다.")
    expect(handoff).toContain("```sql\n" + GOOD_SQL)
    expect(handoff).toContain("## Analyst report")
    const summary = summarizeLedger(readLedger(wt.worktree, S))
    expect(summary).toContain("1. [done] 경기 농장 수 알려줘 — answer: 경기 농장은 22개입니다.; checks: pass; review: accept")
  })

  test("broken SQL fails the checks, the analyst is re-run once with the reason, the fixed answer passes", async () => {
    const deps = makeDeps(client, wt.worktree, dataCfg())
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies["data-analyst"] = (_o, nth) => (nth === 1 ? { text: answer("SELECT count(*) FROM tb_place WHERE sido = '경기'") } : { text: answer(GOOD_SQL) })
    client.replies["data-verifier"] = { text: "ACCEPT" }
    q.add(S, [{ title: "경기 농장 수", kind: "data" }])
    const run = await q.run(S)
    expect(run).toMatchObject({ done: 1, failed: 0 })
    const p = prompts("data-analyst")
    expect(p.length).toBe(2)
    expect(p[1]).toContain("A previous answer to this question was not accepted. Reason: checks failed: answer SQL failed: no such table: tb_place")
    expect(prompts("data-verifier").length).toBe(1) // no verdict asked on an unchecked answer
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.attempts).toBe(2)
    expect(t.status).toBe("done")
  })

  test("no SQL block: retried, then failed; ANSWER without SQL = blocked (no retry); a named suite failure is reported", async () => {
    const deps = makeDeps(client, wt.worktree, dataCfg())
    const q = createQueue(getOpenCodeRuntime(deps))
    writeSuite("strict", [{ name: "exactly 1", expect: { value: 1 } }])
    let calls = 0
    client.replies["data-analyst"] = (o) => {
      calls++
      const text = o.body.parts[0].text as string
      if (text.startsWith("Question: no sql")) return { text: "I could not find it." }
      if (text.startsWith("Question: blocked")) return { text: "ANSWER: 데이터에 해당 컬럼이 없어 답할 수 없습니다." }
      return { text: answer(GOOD_SQL) }
    }
    client.replies["data-verifier"] = { text: "ACCEPT" }
    q.add(S, [
      { title: "no sql", kind: "data" },
      { title: "blocked", kind: "data" },
      { title: "strict suite", kind: "data", verify: "strict" },
    ])
    const run = await q.run(S)
    expect(run).toMatchObject({ done: 0, failed: 3 })
    const tasks = readLedger(wt.worktree, S).tasks
    expect(tasks[0]).toMatchObject({ status: "failed", attempts: 2 })
    expect(tasks[0]!.error).toMatch(/no SQL: block/)
    expect(tasks[1]).toMatchObject({ status: "failed", attempts: 1, blocked: "데이터에 해당 컬럼이 없어 답할 수 없습니다." })
    expect(tasks[2]).toMatchObject({ status: "failed", attempts: 2 })
    expect(tasks[2]!.verify_result).toMatchObject({ command: "data_check strict", ok: false })
    expect(tasks[2]!.verify_result!.output).toContain("FAIL exactly 1: value 22, expected 1")
    expect(calls).toBe(5)
    expect(prompts("data-verifier").length).toBe(0)
    const summary = summarizeLedger(readLedger(wt.worktree, S))
    expect(summary).toContain("analyst: 데이터에 해당 컬럼이 없어")
  })

  test("verifier REJECT retries once; a second REJECT on a checked answer is advisory; review_strict fails it", async () => {
    const deps = makeDeps(client, wt.worktree, dataCfg())
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies["data-analyst"] = { text: answer(GOOD_SQL) }
    client.replies["data-verifier"] = { text: "1. no: 경기 vs 경기도\n2. yes\n3. yes\nREJECT: sido filter" }
    q.add(S, [{ title: "q", kind: "data" }])
    expect(await q.run(S)).toMatchObject({ done: 1, failed: 0 })
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.attempts).toBe(2)
    expect(t.error).toMatch(/accepted with verifier objection: sido filter/)
    expect(prompts("data-analyst")[1]).toContain("Reason: verifier rejected: sido filter")

    const strict = makeDeps(fakeClient({ promptAsync: true }), wt.worktree, { ...dataCfg(), delegate: { review_strict: true } as any })
    ;(strict.client as any).session = client.session
    const q2 = createQueue(getOpenCodeRuntime(strict))
    q2.add("ses_strict", [{ title: "q2", kind: "data" }])
    expect(await q2.run("ses_strict")).toMatchObject({ done: 0, failed: 1 })
  })

  for (const reviewStrict of [false, true]) {
    test(`malformed data-verifier verdict with passing checks (review_strict=${reviewStrict})`, async () => {
      client = fakeClient({ promptAsync: true })
      const deps = makeDeps(client, wt.worktree, { ...dataCfg(), delegate: { review_strict: reviewStrict, max_attempts: 2 } as any })
      const q = createQueue(getOpenCodeRuntime(deps))
      client.replies["data-analyst"] = { text: answer(GOOD_SQL) }
      client.replies["data-verifier"] = { text: "The answer looks good to me." }
      q.add(S, [{ title: "q", kind: "data" }])
      const run = await q.run(S)
      expect(run).toMatchObject(reviewStrict ? { done: 0, failed: 1 } : { done: 1, failed: 0 })
      const task = readLedger(wt.worktree, S).tasks[0]!
      expect(task.verify_result?.ok).toBe(true)
      expect(task.review?.verdict).toBe("error")
      expect(task.attempts).toBe(reviewStrict ? 2 : 1)
      if (reviewStrict) expect(task.error).toContain("verifier gave no verdict")
      expect(prompts("data-analyst")).toHaveLength(reviewStrict ? 2 : 1)
      expect(prompts("data-verifier")).toHaveLength(reviewStrict ? 2 : 1)
    })
  }

  test("data and code tasks mix in one run; the code task keeps its snapshot/review path", async () => {
    const deps = makeDeps(client, wt.worktree, { ...dataCfg(), delegate: { review: false } as any })
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies["data-analyst"] = { text: answer(GOOD_SQL) }
    client.replies.worker = { text: "Files changed: a.py\nVerification: ok\nOpen issues: none", run: () => writeFileSync(join(wt.worktree, "a.py"), "X = 1\n") }
    q.add(S, [
      { title: "count", kind: "data" },
      { title: "write a.py", detail: "create a.py" },
    ])
    expect(await q.run(S)).toMatchObject({ done: 2, failed: 0 })
    const [d, c] = readLedger(wt.worktree, S).tasks
    expect(d!.answer).toBeDefined()
    expect(c!.filesChanged).toEqual(["a.py"])
    // the code task's handoff context mentions the data task's answer, not files
    expect(prompts("worker")[0]).toContain("Task 1 (done): count [answer: 경기 농장은 22개입니다.]")
  })

  test("prompt builders", () => {
    const ledger = { version: 1 as const, sessionID: S, createdAt: 0, updatedAt: 0, tasks: [] }
    const task = { id: "t1", n: 1, batch: 1, title: "Q?", detail: "only 2024", kind: "data" as const, status: "pending" as const, attempts: 0, createdAt: 0, childSessions: [] }
    expect(analystPrompt(ledger, task, undefined, 600)).toBe("Question: Q?\nConstraints: only 2024")
    expect(analystPrompt(ledger, task, "checks failed: x", 600)).toContain("Reason: checks failed: x")
    const v = verifierPrompt(task, "SELECT 1", { suite: "default", ok: true, results: [{ name: "a", ok: true, detail: "ok" }], rows: { columns: ["x"], rows: [[1]] } })
    expect(v).toBe("Question: Q?\nConstraints: only 2024\n\nSQL:\nSELECT 1\n\nResult (executed by the framework, first rows):\nx\n1\n-- 1 row\n\nChecks (default):\nPASS a")
  })
})

describe("delegate tool: kind data", () => {
  const ctx = (agent = "main") => ({ sessionID: S, messageID: "m", agent, directory: wt.worktree, worktree: wt.worktree, abort: new AbortController().signal, metadata() {}, ask: async () => {} })

  test("schema stays within the prefix budget and accepts kind", () => {
    const json = z.toJSONSchema(z.object(delegateArgs))
    expect(estimateToolSchemaTokens(DELEGATE_DESCRIPTION, json)).toBeLessThanOrEqual(400)
    expect(DELEGATE_DESCRIPTION).toMatch(/kind "data"/)
  })

  test("data tasks are refused without a backend, with a missing suite, and never go through the code-task text filter", async () => {
    const off = createDelegateTool(makeDeps(client, wt.worktree))
    await expect(off.execute({ tasks: [{ title: "how many farms", kind: "data" }] } as any, ctx() as any)).rejects.toThrow(/no database is configured/)
    const on = createDelegateTool(makeDeps(client, wt.worktree, dataCfg()))
    await expect(on.execute({ tasks: [{ title: "how many farms", kind: "data", verify: "nope" }] } as any, ctx() as any)).rejects.toThrow(/check suite not found/)
    // a question that mentions "delete the test" is a question, not an instruction to a worker
    client.replies["data-analyst"] = { text: answer(GOOD_SQL) }
    client.replies["data-verifier"] = { text: "ACCEPT" }
    const out: any = await on.execute({ tasks: [{ title: "how many farms delete the test rows?", kind: "data" }] } as any, ctx() as any)
    expect(out.title).toBe("delegate: 1/1 done")
    expect(out.output).toContain("answer: 경기 농장은 22개입니다.")
    expect(out.output).not.toContain("not a git repository")
  })
})

describe("main prompt + data mode wiring", () => {
  test("main gets the data rule only with a backend; data mode routes through delegate", async () => {
    expect(mainPrompt(true)).not.toContain(MAIN_RULE_DATA)
    expect(mainPrompt(true, true)).toContain(MAIN_RULE_DATA)
    expect(mainPrompt(false, true)).not.toContain(MAIN_RULE_DATA)
    expect(estimateTokens(mainPrompt(true, true))).toBeLessThanOrEqual(1500)
    expect(estimateTokens(DATA_VERIFIER_PROMPT)).toBeLessThanOrEqual(600)
    expect(DATA_VERIFIER_PROMPT).not.toMatch(/data_check/)
    // batch-only agents: small, no tools, injected with the data agents
    expect(estimateTokens(ONTOLOGY_EVOLVER_PROMPT)).toBeLessThanOrEqual(700)
    expect(estimateTokens(ANSWER_JUDGE_PROMPT)).toBeLessThanOrEqual(400)
    expect(MODE_INSTRUCTIONS.data).toMatch(/delegate/)
    expect(MODE_INSTRUCTIONS.data.length).toBeLessThanOrEqual(300)
    expect(MODE_INSTRUCTIONS_NO_DELEGATE.data).not.toMatch(/delegate/)
    const cfg: any = { agent: {} }
    await createConfigHook(fakeDeps(wt.worktree, dataCfg()))(cfg)
    expect(cfg.agent.main.prompt).toContain('kind "data"')
    for (const a of ["ontology-evolver", "answer-judge"]) {
      expect(cfg.agent[a].permission.bash).toBe("deny")
      expect(cfg.agent[a].permission.db_query).toBe("deny")
      expect(cfg.agent[a].permission["evo-semantic_*"]).toBe("deny")
    }
    const plain: any = { agent: {} }
    await createConfigHook(fakeDeps(wt.worktree))(plain)
    expect(plain.agent.main.prompt).not.toContain('kind "data"')
  })
})
