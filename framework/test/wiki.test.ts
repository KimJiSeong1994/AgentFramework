import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { recordToolOutcome } from "../src/telemetry/outcomes.ts"
import { captureWiki, lintWiki, parseLog, registerWiki, statusWiki, summarizeOutcomes, unlockWiki } from "../src/wiki/wiki.ts"

let root: string
let state: string
let oldState: string | undefined
let docsDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lca-wiki-"))
  state = mkdtempSync(join(tmpdir(), "lca-wiki-state-"))
  docsDir = mkdtempSync(join(tmpdir(), "lca-wiki-docs-"))
  oldState = process.env.LCA_STATE_HOME
  process.env.LCA_STATE_HOME = state
  mkdirSync(join(root, "knowledge", "wiki"), { recursive: true })
  writeFileSync(join(root, "knowledge", "AGENTS.md"), "# Schema\nRaw sources are immutable; log is append-only.\n")
  writeFileSync(join(root, "knowledge", "wiki", "index.md"), "# Index\n\n[Log](log.md)\n[Report](reports/tool-outcomes.md)\n")
  writeFileSync(join(root, "knowledge", "wiki", "log.md"), "# Log\n")
  // The real wiki always has the generated report; capture regenerates it.
  mkdirSync(join(root, "knowledge", "wiki", "reports"), { recursive: true })
  writeFileSync(join(root, "knowledge", "wiki", "reports", "tool-outcomes.md"), "# Report\n\n[Index](../index.md)\n")
})
afterEach(() => {
  if (oldState === undefined) delete process.env.LCA_STATE_HOME
  else process.env.LCA_STATE_HOME = oldState
  rmSync(root, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
  rmSync(docsDir, { recursive: true, force: true })
})
function observed(callID: string, status: "completed" | "error", exit = 0) {
  return { type: "tool", id: `part-${callID}`, sessionID: "session-1", callID, tool: "bash", state: {
    status, time: { start: 100, end: 200 }, metadata: { exit }, input: { token: "do-not-store-sentinel" },
    output: "do-not-store-sentinel", error: "do-not-store-sentinel",
  } }
}
function doc(name: string, content: string): string {
  const path = join(docsDir, name)
  writeFileSync(path, content)
  return path
}
function knowledgeFiles(): string[] {
  const files: string[] = []
  function walk(path: string) {
    if (!existsSync(path)) return
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry))
    else files.push(path)
  }
  walk(join(root, "knowledge"))
  return files
}
function snapshot() {
  const files = knowledgeFiles().sort()
  return files.map((f) => `${f}\n${existsSync(f) ? readFileSync(f, "utf8") : ""}`).join("\0")
}

// -- Existing capture behaviour (kept meaningful with the new shared lock/log grammar) -----------------------------

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
  appendFileSync(join(root, "knowledge/wiki/log.md"), "\n## [2026-01-01T00:00:00Z] query | recorded analysis\n")
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

test("a lock left by an exited process is reported as stale and removed only by explicit unlock", () => {
  const lock = join(root, "knowledge/.wiki.lock")
  const dead = spawnSync("bun", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" })
  writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout), at: "2020-01-01T00:00:00.000Z" }))
  expect(lintWiki(root)[0]).toContain("Stale wiki lock")
  expect(lintWiki(root)[0]).toContain("unlock")
  expect(statusWiki(root)).toMatchObject({ locked: true })
  expect(() => registerWiki(root, doc("stale.md", "# Stale\n\nbody\n"))).toThrow("Stale wiki lock")
  expect(existsSync(lock)).toBe(true)
  expect(unlockWiki(root)).toEqual({ removed: true, pid: Number(dead.stdout) })
  expect(registerWiki(root, doc("stale.md", "# Stale\n\nbody\n")).created).toBe(true)
  expect(existsSync(lock)).toBe(false)
  expect(unlockWiki(root)).toEqual({ removed: false, pid: null })
  expect(lintWiki(root)).toEqual([])
})

test("unlock refuses live and unreadable locks", () => {
  const lock = join(root, "knowledge/.wiki.lock")
  for (const content of [JSON.stringify({ pid: process.pid }), "not-json", JSON.stringify({ pid: -1 })]) {
    writeFileSync(lock, content)
    expect(() => unlockWiki(root)).toThrow("refusing to remove")
    expect(readFileSync(lock, "utf8")).toBe(content)
  }
})

test("concurrent writers are mutually exclusive: every success is fully recorded, refusals write nothing", async () => {
  const script = join(import.meta.dir, "../../scripts/lca-wiki.ts")
  const names = ["a", "b", "c", "d", "e", "f"]
  const runs = await Promise.all(names.map((n) => {
    const file = doc(`race-${n}.md`, `# Race ${n}\n\nbody ${n}\n`)
    return Bun.spawn(["bun", script, "register", file, "--root", root], { stdout: "pipe", stderr: "pipe" }).exited
  }))
  const ok = runs.filter((c) => c === 0).length
  expect(ok).toBeGreaterThanOrEqual(1)
  expect(statusWiki(root).pending).toHaveLength(ok)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
  expect(lintWiki(root)).toEqual([])
})

test("a lock held by a live process is never reclaimed", () => {
  const lock = join(root, "knowledge/.wiki.lock")
  const live = JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
  writeFileSync(lock, live)
  expect(() => registerWiki(root, doc("live.md", "# Live\n\nbody\n"))).toThrow("Wiki lock exists")
  expect(readFileSync(lock, "utf8")).toBe(live)
})

test("empty, whitespace-only or secret-looking titles are refused without writes", () => {
  const before = knowledgeFiles().map((p) => p + readFileSync(p, "utf8")).join("\n")
  for (const title of ["", "   ", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"]) {
    expect(() => registerWiki(root, doc("t.md", "body only\n"), { title })).toThrow("Register title")
  }
  expect(knowledgeFiles().map((p) => p + readFileSync(p, "utf8")).join("\n")).toBe(before)
})

test("identical bytes cannot be registered under both .md and .txt", () => {
  registerWiki(root, doc("same.md", "same bytes\n"))
  expect(() => registerWiki(root, doc("same.txt", "same bytes\n"))).toThrow("already registered as .md")
  expect(statusWiki(root).pending).toHaveLength(1)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
})

test("register refuses a symlinked log instead of appending through it", () => {
  const outside = join(docsDir, "outside-log.md")
  writeFileSync(outside, "# Log\n")
  rmSync(join(root, "knowledge/wiki/log.md"))
  symlinkSync(outside, join(root, "knowledge/wiki/log.md"))
  expect(() => registerWiki(root, doc("x.md", "# X\n\nbody\n"))).toThrow("regular file")
  expect(readFileSync(outside, "utf8")).toBe("# Log\n")
  expect(existsSync(join(root, "knowledge/raw/documents"))).toBe(false)
  expect(existsSync(join(root, "knowledge/wiki/sources"))).toBe(false)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
})

test("CLI status exits 1 while the wiki is locked", () => {
  writeFileSync(join(root, "knowledge/.wiki.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const r = spawnSync("bun", [join(import.meta.dir, "../../scripts/lca-wiki.ts"), "status", "--root", root], { encoding: "utf8" })
  expect(r.status).toBe(1)
  expect(JSON.parse(r.stdout)).toMatchObject({ locked: true })
})

test("existing wiki lock is not removed or overwritten", () => {
  const lock = join(root, "knowledge/.wiki.lock")
  writeFileSync(lock, "existing-owner")
  expect(() => captureWiki(root)).toThrow()
  expect(readFileSync(lock, "utf8")).toBe("existing-owner")
  expect(lintWiki(root)[0]).toContain("lock")
  expect(statusWiki(root).problems[0]).toContain("lock")
  expect(() => registerWiki(root, doc("a.md", "# A\n\nbody\n"))).toThrow()
  expect(readFileSync(lock, "utf8")).toBe("existing-owner")
})

test("symlinked raw directories do not receive exported data", () => {
  const outside = mkdtempSync(join(tmpdir(), "lca-wiki-outside-"))
  try {
    symlinkSync(outside, join(root, "knowledge/raw"))
    expect(() => captureWiki(root)).toThrow("must not be a symlink")
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

// -- parseLog ---------------------------------------------------------------------------------------------------

test("parseLog only recognizes well-formed ISO headings with a known op", () => {
  const text = [
    "# Log", "",
    "## [2026-01-01T00:00:00Z] capture | 도구 실행 관측", "", "- source_id: abc", "",
    "## [2026-01-02T00:00:00.500Z] register | Some Title", "", "- source_id: def", "body line", "",
    "## not a heading", "random text",
    "## [bad-date] query | oops",
  ].join("\n")
  const entries = parseLog(text)
  expect(entries.length).toBe(2)
  expect(entries[0]).toMatchObject({ op: "capture", title: "도구 실행 관측" })
  expect(entries[0]!.body).toContain("source_id: abc")
  expect(entries[1]!.body).toContain("source_id: def")
  expect(entries[1]!.body).toContain("body line")
})

// -- register: happy path -----------------------------------------------------------------------------------------

test("register happy path writes byte-identical raw, source page, index and log; lint is clean", () => {
  const source = doc("notes.md", "# My Notes\n\nSome content here.\n")
  const receipt = registerWiki(root, source, {})
  expect(receipt.created).toBe(true)
  expect(receipt.title).toBe("My Notes")
  expect(receipt.kind).toBe("documents")
  const rawPath = join(root, receipt.source)
  expect(readFileSync(rawPath)).toEqual(readFileSync(source))
  const summary = readFileSync(join(root, receipt.summary), "utf8")
  expect(summary).toContain(`source_id: ${receipt.sourceId}`)
  expect(summary).toContain("notes\\.md")
  expect(readFileSync(join(root, "knowledge/wiki/index.md"), "utf8")).toContain(`sources/documents-${receipt.sourceId}.md`)
  const log = readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")
  expect(log).toContain(`register | My Notes`)
  expect(log).toContain(`source_id: ${receipt.sourceId}`)
  expect(lintWiki(root)).toEqual([])
})

test("re-registering identical bytes is idempotent: raw/page/index/log stay byte-identical, created=false, different --title ignored", () => {
  const source = doc("notes.md", "# My Notes\n\nSome content here.\n")
  const first = registerWiki(root, source, {})
  const before = snapshot()
  const second = registerWiki(root, source, { title: "A Different Title" })
  expect(second.created).toBe(false)
  expect(second.sourceId).toBe(first.sourceId)
  expect(second.title).toBe("My Notes")
  expect(snapshot()).toBe(before)
  const log = readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")
  expect(log.split(`source_id: ${first.sourceId}`).length - 1).toBe(1)
  expect(lintWiki(root)).toEqual([])
})

test("changed content produces a new source id and does not touch the old raw source", () => {
  const source = doc("notes.md", "# My Notes\n\nOriginal.\n")
  const first = registerWiki(root, source, {})
  writeFileSync(source, "# My Notes\n\nChanged.\n")
  const second = registerWiki(root, source, {})
  expect(second.sourceId).not.toBe(first.sourceId)
  expect(existsSync(join(root, first.source))).toBe(true)
  expect(readFileSync(join(root, first.source), "utf8")).toContain("Original.")
  expect(lintWiki(root)).toEqual([])
})

test("title precedence: --title wins, then first H1, then basename without extension", () => {
  const withTitleFlag = registerWiki(root, doc("one.md", "# Heading Title\n\nbody one\n"), { title: "Explicit Title" })
  expect(withTitleFlag.title).toBe("Explicit Title")
  const withHeading = registerWiki(root, doc("two.md", "# Heading Title\n\nbody two\n"), {})
  expect(withHeading.title).toBe("Heading Title")
  const withoutHeading = registerWiki(root, doc("three-plain.txt", "just text, no heading\n"), {})
  expect(withoutHeading.title).toBe("three-plain")
})

test("invalid titles are refused with no writes", () => {
  const before = snapshot()
  expect(() => registerWiki(root, doc("a.md", "# A\n\nbody\n"), { title: "x".repeat(121) })).toThrow()
  expect(snapshot()).toBe(before)
  expect(() => registerWiki(root, doc("b.md", "# B\n\nbody\n"), { title: "has\ncontrol" })).toThrow()
  expect(snapshot()).toBe(before)
  expect(() => registerWiki(root, doc("c.md", "# C\n\nbody\n"), { title: "has\x01control" })).toThrow()
  expect(snapshot()).toBe(before)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
})

// -- register: every refusal leaves no raw/index/log/lock change ---------------------------------------------------

test("register refuses a missing file with no writes and no lock left", () => {
  const before = snapshot()
  expect(() => registerWiki(root, join(docsDir, "does-not-exist.md"), {})).toThrow()
  expect(snapshot()).toBe(before)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
})

test("register refuses a symlinked source file", () => {
  const target = doc("real.md", "# Real\n\nbody\n")
  const link = join(docsDir, "link.md")
  symlinkSync(target, link)
  const before = snapshot()
  expect(() => registerWiki(root, link, {})).toThrow()
  expect(snapshot()).toBe(before)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
})

test("register refuses a non-regular file (directory)", () => {
  const dirPath = join(docsDir, "adir")
  mkdirSync(dirPath)
  const before = snapshot()
  expect(() => registerWiki(root, dirPath, {})).toThrow()
  expect(snapshot()).toBe(before)
})

test("register refuses a source already inside knowledge/", () => {
  mkdirSync(join(root, "knowledge", "raw"), { recursive: true })
  const inside = join(root, "knowledge", "raw", "already-here.md")
  writeFileSync(inside, "# Already\n\nbody\n")
  const before = snapshot()
  expect(() => registerWiki(root, inside, {})).toThrow()
  expect(snapshot()).toBe(before)
})

test("register refuses disallowed extensions", () => {
  const before = snapshot()
  expect(() => registerWiki(root, doc("script.sh", "#!/bin/sh\necho hi\n"), {})).toThrow()
  expect(snapshot()).toBe(before)
  expect(() => registerWiki(root, doc("data.MD", "# A\n\nbody\n"), {})).not.toThrow()
})

test("register refuses empty and oversized files", () => {
  const before = snapshot()
  expect(() => registerWiki(root, doc("empty.md", ""), {})).toThrow()
  expect(snapshot()).toBe(before)
  expect(() => registerWiki(root, doc("huge.md", "# H\n\n" + "x".repeat(131073)), {})).toThrow()
  expect(snapshot()).toBe(before)
})

test("register refuses invalid UTF-8 and embedded NUL bytes", () => {
  const before = snapshot()
  const invalidPath = join(docsDir, "invalid.md")
  writeFileSync(invalidPath, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
  expect(() => registerWiki(root, invalidPath, {})).toThrow()
  expect(snapshot()).toBe(before)
  const nulPath = join(docsDir, "nul.md")
  writeFileSync(nulPath, Buffer.from("# A\n\x00body\n"))
  expect(() => registerWiki(root, nulPath, {})).toThrow()
  expect(snapshot()).toBe(before)
})

test("register refuses content containing a secret", () => {
  const before = snapshot()
  expect(() => registerWiki(root, doc("secret.md", "# S\n\napi_key: abcdefgh12345678\n"), {})).toThrow()
  expect(snapshot()).toBe(before)
})

test("register refuses when AGENTS.md/index.md/log.md is missing", () => {
  const source = doc("a.md", "# A\n\nbody\n")
  rmSync(join(root, "knowledge", "AGENTS.md"))
  const before = snapshot()
  expect(() => registerWiki(root, source, {})).toThrow()
  expect(snapshot()).toBe(before)
})

test("register refuses when the lock exists", () => {
  const lock = join(root, "knowledge/.wiki.lock")
  writeFileSync(lock, "owner")
  const before = snapshot()
  expect(() => registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})).toThrow()
  expect(snapshot()).toBe(before)
})

test("register refuses when the raw documents directory is a symlink", () => {
  const outside = mkdtempSync(join(tmpdir(), "lca-wiki-outside-"))
  try {
    mkdirSync(join(root, "knowledge", "raw"), { recursive: true })
    symlinkSync(outside, join(root, "knowledge", "raw", "documents"))
    const before = snapshot()
    expect(() => registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})).toThrow()
    expect(readdirSync(outside)).toEqual([])
    expect(snapshot()).toBe(before)
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test("register refuses when the raw documents path is a plain file", () => {
  mkdirSync(join(root, "knowledge", "raw"), { recursive: true })
  writeFileSync(join(root, "knowledge", "raw", "documents"), "not a directory")
  const before = snapshot()
  expect(() => registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})).toThrow()
  expect(snapshot()).toBe(before)
})

// -- crash recovery / symlink-target-of-write safety ----------------------------------------------------------------

test("crash recovery: missing source page and index line are restored on re-register without duplicating the log", () => {
  const source = doc("notes.md", "# My Notes\n\nContent.\n")
  const receipt = registerWiki(root, source, {})
  // Simulate a crash after the raw write but before page/index/log: delete the page and index line.
  rmSync(join(root, receipt.summary))
  writeFileSync(join(root, "knowledge/wiki/index.md"), "# Index\n\n[Log](log.md)\n[Report](reports/tool-outcomes.md)\n")
  const second = registerWiki(root, source, {})
  expect(second.created).toBe(false)
  expect(second.sourceId).toBe(receipt.sourceId)
  expect(existsSync(join(root, receipt.summary))).toBe(true)
  expect(readFileSync(join(root, "knowledge/wiki/index.md"), "utf8")).toContain(`documents-${receipt.sourceId}.md`)
  const log = readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")
  expect(log.split(`source_id: ${receipt.sourceId}`).length - 1).toBe(1)
  expect(lintWiki(root)).toEqual([])
})

test("symlinked raw/documents receives nothing and leaves no lock on register", () => {
  const outside = mkdtempSync(join(tmpdir(), "lca-wiki-outside-"))
  try {
    symlinkSync(outside, join(root, "knowledge/raw"))
    expect(() => registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})).toThrow("must not be a symlink")
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test("tampered raw document fails lint and blocks re-register", () => {
  const source = doc("notes.md", "# My Notes\n\nContent.\n")
  const receipt = registerWiki(root, source, {})
  appendFileSync(join(root, receipt.source), "tampered")
  expect(lintWiki(root).some((s) => s.includes("integrity mismatch"))).toBe(true)
  expect(() => registerWiki(root, source, {})).toThrow("Immutable raw source hash mismatch")
})

test("no absolute path or home directory leaks into any knowledge file", () => {
  const receipt = registerWiki(root, doc("notes.md", "# My Notes\n\nContent.\n"), {})
  for (const path of knowledgeFiles()) {
    if (!path.endsWith(".md")) continue
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain(docsDir)
    expect(text).not.toContain(root)
    expect(text.includes("~")).toBe(false)
  }
  expect(receipt.source).not.toMatch(/^\//)
  expect(receipt.summary).not.toMatch(/^\//)
})

test("raw .md content with relative ../ links and mailto: does not fail lint (raw files are skipped from link checks)", () => {
  registerWiki(root, doc("linky.md", "# Linky\n\n[escape](../../../etc/passwd) [mail](mailto:a@b.com)\n"), {})
  expect(lintWiki(root)).toEqual([])
})

// -- status ----------------------------------------------------------------------------------------------------------

test("status: pending becomes compiled only via an ingest log entry linking the source page; query/lint/register links do not count", () => {
  const receipt = registerWiki(root, doc("notes.md", "# My Notes\n\nContent.\n"), {})
  let status = statusWiki(root)
  expect(status.sources).toBe(1)
  expect(status.compiled).toBe(0)
  expect(status.pending).toHaveLength(1)
  expect(status.pending[0]!.sourceId).toBe(receipt.sourceId)

  appendFileSync(join(root, "knowledge/wiki/log.md"), `\n## [2026-01-01T00:00:00Z] query | checked source\n\n[link](sources/documents-${receipt.sourceId}.md)\n`)
  status = statusWiki(root)
  expect(status.compiled).toBe(0)

  appendFileSync(join(root, "knowledge/wiki/log.md"), `\n## [2026-01-01T00:00:01Z] ingest | folded into concepts\n\n[origin](sources/documents-${receipt.sourceId}.md)\n`)
  status = statusWiki(root)
  expect(status.compiled).toBe(1)
  expect(status.pending).toHaveLength(0)
})

test("status writes nothing and is deterministic", () => {
  registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})
  const before = snapshot()
  const first = statusWiki(root)
  expect(snapshot()).toBe(before)
  const second = statusWiki(root)
  expect(snapshot()).toBe(before)
  expect(second).toEqual(first)
})

test("status exits/refuses with a problem while the lock exists, and writes nothing", () => {
  registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})
  const lock = join(root, "knowledge/.wiki.lock")
  writeFileSync(lock, "owner")
  const before = snapshot()
  const status = statusWiki(root)
  expect(status.problems.some((p) => p.includes("lock"))).toBe(true)
  expect(snapshot()).toBe(before)
})

// -- lint additions -----------------------------------------------------------------------------------------------

test("lint catches a malformed log heading and an unknown op", () => {
  registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})
  appendFileSync(join(root, "knowledge/wiki/log.md"), "\n## [not-a-timestamp] capture | bad heading\n")
  let problems = lintWiki(root)
  expect(problems.some((p) => p.includes("Malformed wiki log heading"))).toBe(true)

  appendFileSync(join(root, "knowledge/wiki/log.md"), "\n## [2026-01-01T00:00:00Z] unknownop | bad op\n")
  problems = lintWiki(root)
  expect(problems.filter((p) => p.includes("Malformed wiki log heading")).length).toBe(2)
})

test("lint requires every ingest entry to link at least one existing source page", () => {
  registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})
  appendFileSync(join(root, "knowledge/wiki/log.md"), "\n## [2026-01-01T00:00:00Z] ingest | no links here\n\nNo links at all.\n")
  const problems = lintWiki(root)
  expect(problems.some((p) => p.includes("does not link an existing source page"))).toBe(true)
})

test("lint reports a raw source without a page and a page without a raw source", () => {
  const receipt = registerWiki(root, doc("a.md", "# A\n\nbody\n"), {})
  rmSync(join(root, receipt.summary))
  let problems = lintWiki(root)
  expect(problems.some((p) => p.includes("without matching source page") || p.includes("without source page"))).toBe(true)

  const receipt2 = registerWiki(root, doc("b.md", "# B\n\nbody\n"), {})
  rmSync(join(root, receipt2.source))
  problems = lintWiki(root)
  expect(problems.some((p) => p.includes("without matching raw source"))).toBe(true)
})

// -- CLI ------------------------------------------------------------------------------------------------------------

function runCli(args: string[]) {
  return spawnSync("bun", [join(import.meta.dir, "..", "..", "scripts", "lca-wiki.ts"), ...args], { encoding: "utf8" })
}

test("CLI usage errors exit with code 2", () => {
  const unknown = runCli(["bogus"])
  expect(unknown.status).toBe(2)
  const extra = runCli(["lint", "extra-positional"])
  expect(extra.status).toBe(2)
  const badFlag = runCli(["lint", "--nope"])
  expect(badFlag.status).toBe(2)
  const titleWithoutRegister = runCli(["lint", "--title", "x"])
  expect(titleWithoutRegister.status).toBe(2)
})

test("CLI --root drives status against an isolated worktree", () => {
  const cliRoot = mkdtempSync(join(tmpdir(), "lca-wiki-cli-"))
  const cliState = mkdtempSync(join(tmpdir(), "lca-wiki-cli-state-"))
  try {
    mkdirSync(join(cliRoot, "knowledge", "wiki"), { recursive: true })
    writeFileSync(join(cliRoot, "knowledge", "AGENTS.md"), "# Schema\n")
    writeFileSync(join(cliRoot, "knowledge", "wiki", "index.md"), "# Index\n")
    writeFileSync(join(cliRoot, "knowledge", "wiki", "log.md"), "# Log\n")
    const result = spawnSync("bun", [join(import.meta.dir, "..", "..", "scripts", "lca-wiki.ts"), "status", "--root", cliRoot],
      { encoding: "utf8", env: { ...process.env, LCA_STATE_HOME: cliState } })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({ sources: 0, compiled: 0, pending: [], problems: [] })
  } finally {
    rmSync(cliRoot, { recursive: true, force: true })
    rmSync(cliState, { recursive: true, force: true })
  }
})
