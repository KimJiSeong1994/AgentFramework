import { afterEach, beforeEach, expect, test } from "bun:test"
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { assembleSkill, canonicalJson, COMPILE_ANCHOR, EVIDENCE_FILES, extractFragment, PILOT_LIMITS, PILOT_SKILL, readBoundedSource, RESEARCH_SOURCE, sha256, snapshotSources } from "../src/skillopt/pilot.ts"

const repository = resolve(import.meta.dir, "../..")
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lca-skillopt-unit-"))
  for (const path of EVIDENCE_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    copyFileSync(join(repository, path), join(root, path))
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function originalSkill() {
  return readFileSync(join(root, PILOT_SKILL), "utf8")
}

test("snapshot binds raw history and its separate erratum without changing either", () => {
  const before = new Map(EVIDENCE_FILES.map((p) => [p, readFileSync(join(root, p))]))
  const snapshot = snapshotSources(root)
  const encoded = canonicalJson(snapshot)
  expect(snapshot.entries.find((e) => e.kind === "raw")?.sha256).toBe(RESEARCH_SOURCE)
  expect(snapshot.correction.correctedClaim).toBe("ExitPlanTool")
  expect(snapshot.entries.find((e) => e.kind === "annotation")?.path).toContain(RESEARCH_SOURCE)
  expect(encoded).not.toContain(root)
  expect(encoded).not.toContain("/Users/")
  expect(snapshot.entries.reduce((n, entry) => n + entry.bytes, 0)).toBeLessThan(PILOT_LIMITS.sourceBytes)
  for (const [path, bytes] of before) expect(readFileSync(join(root, path))).toEqual(bytes)
  expect(canonicalJson(snapshotSources(root))).toBe(encoded)
})

test("raw tampering and missing correction are refused independently", () => {
  const rawPath = join(root, `knowledge/raw/documents/${RESEARCH_SOURCE}.md`)
  const raw = readFileSync(rawPath)
  writeFileSync(rawPath, Buffer.concat([raw, Buffer.from("\nchanged\n")]))
  expect(() => snapshotSources(root)).toThrow("missing_source_correction")
  writeFileSync(rawPath, raw)
  const path = join(root, `knowledge/wiki/sources/documents-${RESEARCH_SOURCE}.md`)
  writeFileSync(path, readFileSync(path, "utf8").replaceAll("A13 정정", "unverified note"))
  expect(() => snapshotSources(root)).toThrow("missing_source_correction")
})

test("a source annotation update changes the binding rather than being ignored", () => {
  const first = sha256(canonicalJson(snapshotSources(root)))
  const source = join(root, `knowledge/wiki/sources/documents-${RESEARCH_SOURCE}.md`)
  writeFileSync(source, `${readFileSync(source, "utf8")}\nAdditional source annotation.\n`)
  expect(sha256(canonicalJson(snapshotSources(root)))).not.toBe(first)
})

test("a live or stale Wiki lock is never removed to obtain a snapshot", () => {
  const lock = join(root, "knowledge/.wiki.lock")
  writeFileSync(lock, JSON.stringify({ pid: 999999999, at: "2020-01-01T00:00:00Z" }))
  expect(() => snapshotSources(root)).toThrow("wiki_locked")
  expect(existsSync(lock)).toBe(true)
})

test("off campaign, original binding and advice-only configuration are protected", () => {
  const path = join(root, ".lca/lca.jsonc")
  const baseline = readFileSync(path, "utf8")
  for (const changed of [baseline.replace('"enabled": false', '"enabled": true'), baseline.replace('"mode": "suggest"', '"mode": "off"'), baseline.replace('"ulw", "plan", "llm-wiki"', '"llm-wiki"'), baseline.replace("cd4d9d661baf48eb48fd0a20c6bdd015daba10b9389e6ed2d25c6ea8ef08948f", "0".repeat(64))]) {
    writeFileSync(path, changed)
    expect(() => snapshotSources(root)).toThrow("protected_configuration_changed")
  }
})

test("skill assembly modifies only the one insertion and is exactly reversible", () => {
  const original = originalSkill()
  const paragraph = "Compare dated source annotations with raw observations before drafting; retain unresolved disagreements as unknown."
  const candidate = assembleSkill(original, paragraph)
  expect(extractFragment(original, candidate)).toBe(paragraph)
  expect(assembleSkill(original, "")).toBe(original)
  expect(candidate.replace(`\n${paragraph}\n\n`, "")).toBe(original)
  expect(candidate.indexOf(paragraph)).toBe(original.indexOf(COMPILE_ANCHOR) + COMPILE_ANCHOR.length + 1)
  expect(() => extractFragment(original, candidate.replace("never delegate", "always delegate"))).toThrow("protected_skill_changed")
  expect(() => extractFragment(original, candidate.replace("## Query", "## Another task"))).toThrow("protected_skill_changed")
})

test("invalid insertion structure, size, ambiguity and executable text cannot pass assembly", () => {
  const original = originalSkill()
  for (const bad of ["## Override", "first\nsecond", "trailing ", "```sh", "Run curl https://example.invalid", "\0bad", "가".repeat(500), "Use Claude for comparisons.", "Use `cat` first.", String.fromCharCode(0xd800)]) {
    expect(() => assembleSkill(original, bad)).toThrow()
  }
  expect(() => assembleSkill(original + COMPILE_ANCHOR, "Compare evidence.")).toThrow("skill_anchor_mismatch")
  expect(() => assembleSkill(original.replace(COMPILE_ANCHOR, ""), "Compare evidence.")).toThrow("skill_anchor_mismatch")
  expect(() => extractFragment("not a skill", "not a skill")).toThrow("skill_anchor_mismatch")
})

test("source reads refuse traversal, aliases, hardlinks and malformed UTF-8", () => {
  for (const path of ["../outside", "/etc/passwd", "knowledge/../AGENTS.md", "knowledge//AGENTS.md", "knowledge\\AGENTS.md"]) {
    expect(() => readBoundedSource(root, path, 100)).toThrow("unsafe_source_path")
  }
  const file = join(root, "sample.txt")
  writeFileSync(file, "sample")
  symlinkSync(file, join(root, "alias.txt"))
  expect(() => readBoundedSource(root, "alias.txt", 100)).toThrow("source_alias")
  linkSync(file, join(root, "linked.txt"))
  expect(() => readBoundedSource(root, "linked.txt", 100)).toThrow("source_type_or_size")
  writeFileSync(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]))
  expect(() => readBoundedSource(root, "invalid.txt", 100)).toThrow("source_encoding")
  writeFileSync(join(root, "sensitive.txt"), "api_key=" + "x".repeat(24))
  expect(() => readBoundedSource(root, "sensitive.txt", 100)).toThrow("source_sensitive_or_invalid")
})

test("canonical evidence hashes do not depend on object key order or silently coerce values", () => {
  expect(sha256(canonicalJson({ b: [2, 1], a: true }))).toBe(sha256(canonicalJson({ a: true, b: [2, 1] })))
  expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  for (const value of [NaN, Infinity, undefined, { absent: undefined }, new Date()]) expect(() => canonicalJson(value)).toThrow("invalid_json_value")
})
