import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { createRepoSearchProvider } from "../src/repo-search/access.ts"
import { captureRepoCorpus } from "../src/repo-search/corpus.ts"
import { GRAPHIFY_COMMIT } from "../src/repo-search/runtime.ts"

// A fixed retrieval experiment, not an end-to-end model quality or token-cost benchmark.
const cases = [
  ["symbol", "createExecutionPolicy", "framework/src/hosts/tool-policy.ts"],
  ["symbol", "createCliTools", "framework/src/hosts/cli-tools.ts"],
  ["symbol", "createExecutionRuntime", "framework/src/hosts/runtime.ts"],
  ["symbol", "createCliRuntime", "framework/src/hosts/cli-runtime.ts"],
  ["symbol", "memoryToolText", "framework/src/wiki/recall.ts"],
  ["symbol", "loadConfig", "framework/src/config.ts"],
  ["symbol", "validateCliToolInput", "framework/src/hosts/cli-tools.ts"],
  ["symbol", "probeWorkerContainment", "framework/src/skillopt/host.ts"],
  ["symbol", "prepareWorkerProfile", "framework/src/skillopt/host.ts"],
  ["symbol", "beginExecutionActivity", "framework/src/hosts/runtime.ts"],
  ["english", "planning main read only tool allowlist", "framework/src/hosts/tool-policy.ts"],
  ["english", "file path symlink protection worktree identity", "framework/src/hosts/cli-tools.ts"],
  ["english", "create CLI runtime selected model routes", "framework/src/hosts/cli-runtime.ts"],
  ["english", "wiki memory recall query prefetch", "framework/src/wiki/recall.ts"],
  ["english", "load user project configuration", "framework/src/config.ts"],
  ["english", "worker sandbox containment probes", "framework/src/skillopt/host.ts"],
  ["english", "cancel session execution activity", "framework/src/hosts/runtime.ts"],
  ["english", "validate tool input query bounds", "framework/src/hosts/cli-tools.ts"],
  ["english", "CLI tool schemas and dispatch", "framework/src/hosts/cli-host.ts"],
  ["english", "planning conversation memory prefetch", "framework/src/hosts/plan-conversation.ts"],
  ["korean", "계획 단계에서 허용하는 읽기 전용 도구는 어디서 정하나", "framework/src/hosts/tool-policy.ts"],
  ["korean", "심볼릭 링크로 저장소 밖 파일을 읽지 못하게 막는 코드", "framework/src/hosts/cli-tools.ts"],
  ["korean", "선택한 모델로 실행 환경을 만드는 위치", "framework/src/hosts/cli-runtime.ts"],
  ["korean", "위키 기억을 질문에 맞게 불러오는 기능", "framework/src/wiki/recall.ts"],
  ["korean", "사용자 설정과 프로젝트 설정을 합치는 곳", "framework/src/config.ts"],
  ["korean", "작업자 샌드박스 격리를 검증하는 부분", "framework/src/skillopt/host.ts"],
  ["korean", "세션 실행 취소와 진행 상태를 관리하는 코드", "framework/src/hosts/runtime.ts"],
  ["korean", "도구 입력의 길이와 필드를 검사하는 곳", "framework/src/hosts/cli-tools.ts"],
  ["korean", "도구 요청을 실제 실행으로 연결하는 부분", "framework/src/hosts/cli-host.ts"],
  ["korean", "계획 대화에서 기억을 미리 불러오는 위치", "framework/src/hosts/plan-conversation.ts"],
] as const

describe.skipIf(process.env.OTTER_REPO_SEARCH_BENCHMARK !== "1")("approved repository retrieval evaluation", () => {
  test("measures fixed symbol, English and Korean queries against a literal-token file scan", async () => {
    const worktree = resolve(import.meta.dir, "../..")
    const corpus = captureRepoCorpus(worktree, ["framework/src", "framework/test", "scripts", "tests"])
    const sources = corpus.files.map(file => ({ path: file.path, text: file.bytes.toString("utf8") }))
    const provider = createRepoSearchProvider(worktree)
    if (!provider) throw new Error("Benchmark requires an explicitly built, current repository index")
    const results: Array<{
      group: string; query: string; expected: string
      graphRecallAt5: number; baselineRecallAt5: number
      graphMilliseconds: number; baselineMilliseconds: number
      graphOutputBytes: number; graphPaths: string[]
    }> = []
    for (const [group, query, expected] of cases) {
      if (!sources.some(file => file.path === expected)) throw new Error(`Benchmark gold source missing: ${expected}`)
      const started = performance.now()
      const text = await provider({ query, limit: 5 })
      const graphMilliseconds = performance.now() - started
      const hits = text.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as { path: string; line?: number })
      expect(hits.length).toBeLessThanOrEqual(5)
      for (const hit of hits) {
        expect(sources.some(file => file.path === hit.path)).toBe(true)
        if (hit.line !== undefined) expect(hit.line).toBeLessThanOrEqual(readFileSync(resolve(worktree, hit.path), "utf8").split("\n").length)
      }
      const scanStarted = performance.now()
      const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])]
      // Deliberately transparent baseline: OR literal terms, count matched terms,
      // deterministic path tie-break. No model query rewriting or source reasoning.
      const baseline = sources.map(file => ({ path: file.path, score: terms.filter(term => file.text.includes(term)).length }))
        .filter(file => file.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 5)
      results.push({ group, query, expected, graphRecallAt5: hits.some(hit => hit.path === expected) ? 1 : 0, baselineRecallAt5: baseline.some(hit => hit.path === expected) ? 1 : 0, graphMilliseconds, baselineMilliseconds: performance.now() - scanStarted, graphOutputBytes: Buffer.byteLength(text), graphPaths: hits.map(hit => hit.path) })
    }
    const groups = ["symbol", "english", "korean"].map(group => {
      const rows = results.filter(row => row.group === group)
      return { group, queries: rows.length, graphRecallAt5: rows.reduce((sum, row) => sum + row.graphRecallAt5, 0) / rows.length, baselineRecallAt5: rows.reduce((sum, row) => sum + row.baselineRecallAt5, 0) / rows.length }
    })
    const report = { schema: 1, graphifyCommit: GRAPHIFY_COMMIT, sourceFingerprint: corpus.sourceFingerprint, scope: "file retrieval only; no model/token-cost experiment", files: sources.length, queries: results.length, groups, averageGraphMilliseconds: results.reduce((sum, row) => sum + row.graphMilliseconds, 0) / results.length, averageBaselineMilliseconds: results.reduce((sum, row) => sum + row.baselineMilliseconds, 0) / results.length, results }
    if (process.env.OTTER_REPO_SEARCH_BENCHMARK_REPORT) await Bun.write(process.env.OTTER_REPO_SEARCH_BENCHMARK_REPORT, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ ...report, results: undefined }))
  }, 180_000)
})
