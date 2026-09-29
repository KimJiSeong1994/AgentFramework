import { afterEach, beforeEach, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { recordToolOutcome } from "../src/telemetry/outcomes.ts"
import { captureWiki, lintWiki, summarizeOutcomes } from "../src/telemetry/wiki.ts"

let root: string
let state: string
let oldState: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lca-wiki-"))
  state = mkdtempSync(join(tmpdir(), "lca-wiki-state-"))
  oldState = process.env.LCA_STATE_HOME
  process.env.LCA_STATE_HOME = state
  mkdirSync(join(root, "knowledge", "wiki"), { recursive: true })
  writeFileSync(join(root, "knowledge", "AGENTS.md"), "# Schema\nRaw sources are immutable; log is append-only.\n")
  writeFileSync(join(root, "knowledge", "wiki", "index.md"), "# Index\n\n[Log](log.md)\n[Report](reports/tool-outcomes.md)\n")
  writeFileSync(join(root, "knowledge", "wiki", "log.md"), "# Log\n")
})
afterEach(() => {
  if (oldState === undefined) delete process.env.LCA_STATE_HOME
  else process.env.LCA_STATE_HOME = oldState
  rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true })
})
function observed(callID: string, status: "completed" | "error", exit = 0) {
  return { type: "tool", id: `part-${callID}`, sessionID: "session-1", callID, tool: "bash", state: {
    status, time: { start: 100, end: 200 }, metadata: { exit }, input: { token: "do-not-store-sentinel" },
    output: "do-not-store-sentinel", error: "do-not-store-sentinel",
  } }
}

test("empty history is explicitly empty, not fabricated observations", () => {
  const receipt = captureWiki(root)
  expect(receipt.observations).toBe(0)
  expect(readFileSync(join(root, receipt.report), "utf8")).toContain("아직 기록된 도구 실행이 없습니다")
  expect(lintWiki(root)).toEqual([])
})

test("capture preserves raw sources, agent edits, index and append-only log across replay", () => {
  expect(recordToolOutcome(root, observed("call-1", "completed"))).toBe(true)
  const first = captureWiki(root)
  const raw = readFileSync(join(root, first.source), "utf8")
  expect(raw).not.toContain("do-not-store-sentinel")
  appendFileSync(join(root, first.summary), "\nLLM-maintained analysis with provenance.\n")
  appendFileSync(join(root, "knowledge/wiki/log.md"), "\n## [2026-01-01] query | recorded analysis\n")
  const oldLog = readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")
  const second = captureWiki(root)
  expect(second.created).toBe(false)
  expect(second.source).toBe(first.source)
  expect(readFileSync(join(root, first.source), "utf8")).toBe(raw)
  expect(readFileSync(join(root, first.summary), "utf8")).toContain("LLM-maintained analysis")
  expect(readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")).toBe(oldLog)
  expect(lintWiki(root)).toEqual([])
})

test("new observations create a new source, never rewrite an old raw snapshot", () => {
  recordToolOutcome(root, observed("call-1", "completed"))
  const first = captureWiki(root)
  const old = readFileSync(join(root, first.source), "utf8")
  recordToolOutcome(root, observed("call-2", "completed", 2))
  const second = captureWiki(root)
  expect(second.source).not.toBe(first.source)
  expect(second.observations).toBe(2)
  expect(readFileSync(join(root, first.source), "utf8")).toBe(old)
  expect(lintWiki(root)).toEqual([])
})

test("conflicting terminal observations are one unknown call, not two successes", () => {
  recordToolOutcome(root, observed("same-call", "completed"))
  recordToolOutcome(root, observed("same-call", "error"))
  const receipt = captureWiki(root)
  const raw = JSON.parse(readFileSync(join(root, receipt.source), "utf8"))
  const summary = summarizeOutcomes(raw.observations)
  expect(summary.calls).toBe(1)
  expect(summary.conflicts).toBe(1)
  expect(summary.tools[0]).toMatchObject({ success: 0, failure: 0, unknown: 1 })
})

test("tampered raw data is reported, never silently overwritten", () => {
  const receipt = captureWiki(root)
  appendFileSync(join(root, receipt.source), "tampered")
  expect(lintWiki(root).some((s) => s.includes("integrity mismatch"))).toBe(true)
  expect(() => captureWiki(root)).toThrow("Immutable raw source hash mismatch")
  expect(readFileSync(join(root, receipt.source), "utf8")).toEndWith("tampered")
})

test("lint detects orphan pages, broken links and links escaping knowledge", () => {
  captureWiki(root)
  writeFileSync(join(root, "knowledge/wiki/orphan.md"), "# Orphan\n")
  appendFileSync(join(root, "knowledge/wiki/index.md"), "\n[Missing](missing.md)\n[Outside](../../outside.md)\n")
  const problems = lintWiki(root)
  expect(problems.some((s) => s.includes("missing from index"))).toBe(true)
  expect(problems.filter((s) => s.includes("Broken or unsafe")).length).toBe(2)
})

test("existing capture lock is not removed or overwritten", () => {
  const lock = join(root, "knowledge/.capture.lock")
  writeFileSync(lock, "existing-owner")
  expect(() => captureWiki(root)).toThrow()
  expect(readFileSync(lock, "utf8")).toBe("existing-owner")
  expect(lintWiki(root)[0]).toContain("capture lock")
})

test("symlinked raw directories do not receive exported data", () => {
  const outside = mkdtempSync(join(tmpdir(), "lca-wiki-outside-"))
  try {
    symlinkSync(outside, join(root, "knowledge/raw"))
    expect(() => captureWiki(root)).toThrow("must not be a symlink")
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(root, "knowledge/.capture.lock"))).toBe(false)
  } finally { rmSync(outside, { recursive: true, force: true }) }
})
