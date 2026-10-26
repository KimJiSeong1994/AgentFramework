import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  createNativeDataset,
  createSourceManifest,
  NATIVE_DATASET_LIMITS,
  NATIVE_FIXTURE_PACK_SCHEMA,
  NATIVE_PROTECTED_CHANGES,
  NATIVE_PROTOCOL_SHA256,
  NATIVE_SOURCE_MANIFEST_SCHEMA,
  NATIVE_WIKI_CONTRACT,
  NATIVE_WIKI_OUTPUT_SCHEMA,
  NATIVE_WIKI_SPLIT_MINIMUMS,
  NATIVE_WIKI_SPLITS,
  NATIVE_WIKI_STRATA,
  trainerSafeProjection,
  validateNativeDataset,
  validateNativeFixturePack,
  validateNativeWikiOutput,
  validateSourceManifest,
  type NativeModelBindings,
  type NativeWikiFixturePack,
  type NativeWikiSplit,
  type NativeWikiStratum,
} from "../src/skillopt/dataset.ts"
import { NATIVE_SKILLOPT_LIMITS, sha256 } from "../src/skillopt/pilot.ts"

const roots: string[] = []
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "skillopt-dataset-test-"))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function sourceFile(rootPath: string, content: string | Uint8Array, path?: string): string {
  const bytes = Buffer.from(content)
  const relative = path ?? `knowledge/raw/documents/${sha256(bytes)}.md`
  const absolute = join(rootPath, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, bytes)
  return relative
}

function sourceSelectionFixture(rootPath: string) {
  const content = "한글 인용 근거\n"
  const path = sourceFile(rootPath, content)
  return { path, content }
}

function modelBindings(): NativeModelBindings {
  return {
    generator: {
      engine: "codex",
      requestedModel: "gpt-5-codex",
      runtimeIdentity: { version: "codex-cli-1.2.3", executableSha256: "a".repeat(64) },
      profileIdentity: { id: "codex-restricted-read.v1", sha256: "b".repeat(64) },
    },
    target: {
      engine: "claude",
      requestedModel: "claude-sonnet-4-5",
      runtimeIdentity: { version: "claude-cli-2.3.4", executableSha256: "c".repeat(64) },
      profileIdentity: { id: "claude-native-no-tools.v1", sha256: "d".repeat(64) },
    },
    reviewer: {
      engine: "claude",
      requestedModel: "claude-opus-4-1",
      runtimeIdentity: { version: "claude-cli-2.3.4", executableSha256: "c".repeat(64) },
      profileIdentity: { id: "claude-native-no-tools.v1", sha256: "e".repeat(64) },
    },
  }
}

function splitStratum(split: NativeWikiSplit, index: number): NativeWikiStratum {
  return NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!
}

function makeFixture(split: NativeWikiSplit, index: number, stratum: NativeWikiStratum) {
  const id = `${split}-${index}`
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const leftFactId = `fact-${id}-a`
  const rightFactId = `fact-${id}-b`
  const leftStatement = `Supported fact A for ${id}.`
  const rightStatement = `Supported fact B for ${id}.`
  const content = `${leftStatement}\n${rightStatement}\n`
  const sourceHash = sha256(content)
  const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
  const line = (statement: string) => `- ${escape(statement)} ([${escape(sourceId)}](../sources/documents-${sourceHash}.md))`
  const existingContent = stratum === "dedup-resume"
    ? `${line(leftStatement)}\n`
    : stratum === "ownership-injection"
      ? `${line(leftStatement)}\n${line(rightStatement)}\n`
      : ""
  return {
    id,
    familyId: `family-${id}`,
    lineage: [`lineage-${id}`],
    split,
    stratum,
    authorship: "agent-authored" as const,
    sources: [{ id: sourceId, provenance: "raw" as const, content, sha256: sourceHash }],
    task: `Prepare a bounded wiki update for [[slot:${slotId}]] using only its cited evidence.`,
    outputSlots: [{ id: slotId, kind: "page" as const, existingContent }],
    assertions: {
      facts: [
        { id: leftFactId, slotId, statement: leftStatement, sourceIds: [sourceId] },
        { id: rightFactId, slotId, statement: rightStatement, sourceIds: [sourceId] },
      ],
      citations: [
        { factId: leftFactId, sourceId },
        { factId: rightFactId, sourceId },
      ],
      contradictions: stratum === "correction-conflict"
        ? [{ leftFactId, rightFactId, expected: "mark-unknown" as const }]
        : [],
      deduplication: stratum === "dedup-resume"
        ? [{ slotId, expected: "reuse-existing" as const }]
        : [],
      ownership: stratum === "ownership-injection"
        ? [{ slotId, expected: "preserve-existing" as const }]
        : [],
    },
    forbiddenChanges: [...NATIVE_PROTECTED_CHANGES],
  }
}

function makePack(counts: Readonly<Record<NativeWikiSplit, number>> = NATIVE_WIKI_SPLIT_MINIMUMS): Mutable<NativeWikiFixturePack> {
  const fixtures: ReturnType<typeof makeFixture>[] = []
  for (const split of NATIVE_WIKI_SPLITS) {
    for (let index = 0; index < counts[split]; index += 1) {
      fixtures.push(makeFixture(split, index, splitStratum(split, index)))
    }
  }
  return { schema: NATIVE_FIXTURE_PACK_SCHEMA, contract: NATIVE_WIKI_CONTRACT, fixtures }
}

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value))
}

test("selection defaults empty, excludes digest metadata and cannot satisfy DATA_REQUIRED", () => {
  const root = tempRoot()
  const manifest = createSourceManifest(root)
  expect(manifest.entries).toEqual([])
  expect(manifest.exportSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(manifest)).not.toContain(root)
  const dataset = createNativeDataset({ root, fixturePack: makePack(), modelBindings: modelBindings() })
  expect(dataset.status).toBe("DATA_REQUIRED")
  expect(dataset.requirements).toContain("source_selection_required")
  expect(() => createSourceManifest(root, [{ path: `knowledge/raw/session-digests/${"a".repeat(64)}.json` }])).toThrow("source_selection_not_allowed")

  const pack = clone(makePack())
  const digest = JSON.stringify({ schemaVersion: 1, kind: "session-digest-snapshot", digests: [] })
  pack.fixtures[0]!.sources[0]!.content = digest
  pack.fixtures[0]!.sources[0]!.sha256 = sha256(digest)
  expect(() => validateNativeFixturePack(pack)).toThrow("metadata_only_source")
})

test("explicit selected source manifests bind provenance and UTF-8 byte excerpts", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const bytes = Buffer.from(selected.content, "utf8")
  const selection = { path: selected.path, excerpt: { startByte: 0, endByte: 3 } }
  const manifest = createSourceManifest(root, [selection])
  expect(manifest.schema).toBe(NATIVE_SOURCE_MANIFEST_SCHEMA)
  expect(manifest.entries[0]?.provenance).toBe("raw")
  expect(manifest.entries[0]?.sourceSha256).toBe(sha256(bytes))
  expect(manifest.entries[0]?.excerpt).toEqual({ startByte: 0, endByte: 3, sha256: sha256(bytes.subarray(0, 3)), text: "한" })
  expect(validateSourceManifest(root, manifest)).toEqual(manifest)
  expect(() => createSourceManifest(root, [{ path: selected.path, excerpt: { startByte: 1, endByte: 3 } }])).toThrow("source_excerpt_boundary")

  const annotation = "검토된 정정 근거\n"
  const annotationPath = sourceFile(root, annotation, `knowledge/wiki/sources/documents-${"f".repeat(64)}.md`)
  const two = createSourceManifest(root, [{ path: annotationPath }, { path: selected.path }])
  expect(two.entries.map((entry) => entry.provenance)).toEqual(["raw", "annotation"])
  expect(createSourceManifest(root, [{ path: selected.path }, { path: annotationPath }]).manifestSha256).toBe(two.manifestSha256)
})

test("source byte, UTF-8 and secret bounds fail closed without disclosing source values", () => {
  const root = tempRoot()
  const tooLarge = Buffer.alloc(NATIVE_DATASET_LIMITS.sourceFileBytes + 1, 0x78)
  const tooLargePath = `knowledge/raw/documents/${sha256(tooLarge)}.md`
  sourceFile(root, tooLarge, tooLargePath)
  expect(() => createSourceManifest(root, [{ path: tooLargePath }])).toThrow("source_type_or_size")

  const invalidUtf8 = Buffer.from([0xc3, 0x28])
  const invalidPath = `knowledge/raw/documents/${sha256(invalidUtf8)}.md`
  sourceFile(root, invalidUtf8, invalidPath)
  expect(() => createSourceManifest(root, [{ path: invalidPath }])).toThrow("source_encoding")

  const secret = `api_key=${"x".repeat(24)}`
  const secretPath = sourceFile(root, secret)
  try {
    createSourceManifest(root, [{ path: secretPath }])
    throw new Error("expected secret rejection")
  } catch (error) {
    expect(String(error)).toContain("source_sensitive_or_invalid")
    expect(String(error)).not.toContain(secret)
  }
  expect(() => createSourceManifest(root, Array.from({ length: 65 }, () => ({ path: "knowledge/AGENTS.md" })))).toThrow("source_limit")

  const aggregateRoot = tempRoot()
  const aggregateSelections = Array.from({ length: 17 }, (_, index) => {
    const bytes = Buffer.alloc(NATIVE_DATASET_LIMITS.sourceFileBytes, 0x78)
    bytes[0] = 0x41 + index
    const path = sourceFile(aggregateRoot, bytes)
    return { path, excerpt: { startByte: 0, endByte: 1 } }
  })
  expect(() => createSourceManifest(aggregateRoot, aggregateSelections)).toThrow("source_limit")
})

test("source selections reject aliases and returned manifests detach from mutable callers", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const aliasPath = "knowledge/wiki/concepts/alias.md"
  const aliasFile = join(root, aliasPath)
  mkdirSync(dirname(aliasFile), { recursive: true })
  symlinkSync(join(root, selected.path), aliasFile)
  expect(() => createSourceManifest(root, [{ path: aliasPath }])).toThrow("source_alias")

  const hardRoot = tempRoot()
  const realPath = sourceFile(hardRoot, "stable source")
  const hardAlias = `knowledge/raw/documents/${"0".repeat(64)}.md`
  const hardAliasAbsolute = join(hardRoot, hardAlias)
  mkdirSync(dirname(hardAliasAbsolute), { recursive: true })
  linkSync(join(hardRoot, realPath), hardAliasAbsolute)
  expect(() => createSourceManifest(hardRoot, [{ path: hardAlias }])).toThrow("source_type_or_size")

  const mutableSelection = { path: sourceFile(hardRoot, "another independent source") }
  const manifest = createSourceManifest(hardRoot, [mutableSelection])
  mutableSelection.path = "knowledge/wiki/log.md"
  expect(manifest.entries[0]?.path).not.toBe(mutableSelection.path)
  expect(Object.isFrozen(manifest.entries)).toBe(true)
  expect(Object.isFrozen(manifest.entries[0]?.excerpt)).toBe(true)
})

test("source and dataset digests are rechecked against mutation", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const manifest = createSourceManifest(root, [{ path: selected.path }])
  writeFileSync(join(root, selected.path), "changed selected source")
  expect(() => validateSourceManifest(root, manifest)).toThrow("source_digest_mismatch")

  const otherRoot = tempRoot()
  const fresh = sourceSelectionFixture(otherRoot)
  const dataset = createNativeDataset({ root: otherRoot, selections: [{ path: fresh.path }], fixturePack: makePack(), modelBindings: modelBindings() })
  const altered = clone(dataset) as unknown as Record<string, unknown>
  altered.datasetSha256 = "0".repeat(64)
  expect(() => validateNativeDataset(otherRoot, altered)).toThrow("dataset_digest_mismatch")
  const alteredManifest = clone(dataset.sourceManifest) as unknown as Record<string, unknown>
  alteredManifest.exportSha256 = "0".repeat(64)
  expect(() => validateSourceManifest(otherRoot, alteredManifest)).toThrow("source_manifest_digest_mismatch")
})

test("fixture pack exact schemas reject malformed and humanApproved passthrough fields", () => {
  const pack = clone(makePack()) as unknown as Record<string, unknown>
  pack.humanApproved = true
  expect(() => validateNativeFixturePack(pack)).toThrow("fixture_pack_invalid")

  const malformed = clone(makePack())
  ;(malformed.fixtures[0] as unknown as Record<string, unknown>).extra = "untrusted"
  expect(() => validateNativeFixturePack(malformed)).toThrow("fixture_pack_invalid")

  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  expect(() => createSourceManifest(root, [{ path: selected.path, humanApproved: true } as never])).toThrow("source_selection_invalid")
  expect(() => createNativeDataset({ root, fixturePack: makePack(), modelBindings: { ...modelBindings(), humanApproved: true } })).toThrow("unsupported_model")
})

test("fact assertions bind to explicit slots, and contradiction pairs cannot span slots", () => {
  const missingSlot = clone(makePack())
  missingSlot.fixtures[0]!.assertions.facts[0]!.slotId = "not-declared"
  expect(() => validateNativeFixturePack(missingSlot)).toThrow("fixture_assertion_invalid")

  const crossSlot = clone(makePack())
  const fixture = crossSlot.fixtures.find(item => item.stratum === "correction-conflict")!
  fixture.outputSlots.push({ id: "second-slot", kind: "report", existingContent: "" })
  fixture.task = `${fixture.task} [[slot:second-slot]]`
  fixture.assertions.facts[0]!.slotId = "second-slot"
  expect(() => validateNativeFixturePack(crossSlot)).toThrow("fixture_assertion_invalid")

  const missingCitation = clone(makePack())
  missingCitation.fixtures[0]!.assertions.citations.pop()
  expect(() => validateNativeFixturePack(missingCitation)).toThrow("fixture_assertion_invalid")
})

test("split minima and all four strata are required per split", () => {
  const complete = validateNativeFixturePack(makePack())
  expect(complete.status).toBe("STRUCTURALLY_VALID")
  expect(complete.pack.fixtures.every((fixture) => fixture.authorship === "agent-authored")).toBe(true)
  expect(complete).not.toHaveProperty("humanApproved")
  expect(complete.packSha256).toMatch(/^[a-f0-9]{64}$/)
  for (const split of NATIVE_WIKI_SPLITS) {
    expect(complete.coverage[split].count).toBe(NATIVE_WIKI_SPLIT_MINIMUMS[split])
    expect(complete.coverage[split].missingStrata).toEqual([])
  }

  const short = clone(makePack({ ...NATIVE_WIKI_SPLIT_MINIMUMS, train: 23 }))
  const shortValidation = validateNativeFixturePack(short)
  expect(shortValidation.status).toBe("DATA_REQUIRED")
  expect(shortValidation.requirements).toContain("split_minimums")

  const missingStrata = clone(makePack())
  for (const fixture of missingStrata.fixtures.filter((item) => item.split === "train")) fixture.stratum = "citation-boundary"
  const strataValidation = validateNativeFixturePack(missingStrata)
  expect(strataValidation.status).toBe("DATA_REQUIRED")
  expect(strataValidation.requirements).toContain("strata_coverage")
})

test("fixture pack is bounded independently from per-fixture native input", () => {
  const oversized = clone(makePack())
  for (const fixture of oversized.fixtures) {
    const content = `${fixture.id}-${"x".repeat(8 * 1024)}`
    fixture.sources[0]!.content = content
    fixture.sources[0]!.sha256 = sha256(content)
  }
  expect(() => validateNativeFixturePack(oversized)).toThrow("fixture_pack_limit")
})

test("family, declared lineage and exact source content cannot cross fixture families", () => {
  const duplicateFamily = clone(makePack())
  duplicateFamily.fixtures.find((fixture) => fixture.split === "dev")!.familyId = duplicateFamily.fixtures.find((fixture) => fixture.split === "train")!.familyId
  expect(() => validateNativeFixturePack(duplicateFamily)).toThrow("fixture_family_reuse")

  const duplicateLineage = clone(makePack())
  duplicateLineage.fixtures.find((fixture) => fixture.split === "dev")!.lineage = duplicateLineage.fixtures.find((fixture) => fixture.split === "train")!.lineage
  expect(() => validateNativeFixturePack(duplicateLineage)).toThrow("fixture_lineage_reuse")

  const duplicateContent = clone(makePack())
  const trainSource = duplicateContent.fixtures.find((fixture) => fixture.split === "train")!.sources[0]!
  const devSource = duplicateContent.fixtures.find((fixture) => fixture.split === "dev")!.sources[0]!
  devSource.content = trainSource.content
  devSource.sha256 = trainSource.sha256
  expect(() => validateNativeFixturePack(duplicateContent)).toThrow("fixture_source_content_reuse")

  const digestMismatch = clone(makePack())
  digestMismatch.fixtures[0]!.sources[0]!.sha256 = "0".repeat(64)
  expect(() => validateNativeFixturePack(digestMismatch)).toThrow("fixture_source_digest_mismatch")
})

test("trainer projection contains train gold and dev inputs only, never holdout identities or gold", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const dataset = createNativeDataset({ root, selections: [{ path: selected.path }], fixturePack: makePack(), modelBindings: modelBindings() })
  expect(dataset.status).toBe("STRUCTURALLY_VALID")
  const projection = trainerSafeProjection(dataset)
  expect(projection.train).toHaveLength(24)
  expect(projection.dev).toHaveLength(16)
  expect(projection.train[0]).toHaveProperty("assertions")
  expect(projection.dev[0]).not.toHaveProperty("assertions")
  expect(projection).not.toHaveProperty("fixtures")
  const encoded = JSON.stringify(projection)
  expect(encoded).not.toContain("final-0")
  expect(encoded).not.toContain("safety-0")
  expect(encoded).not.toContain("family-final-0")
  expect(encoded).not.toContain("Supported fact A for final-0.")
  expect(encoded).not.toContain("Supported fact A for safety-0.")
  expect(projection.projectionSha256).toMatch(/^[a-f0-9]{64}$/)

  const alteredOriginal = makePack()
  const checked = validateNativeFixturePack(alteredOriginal)
  alteredOriginal.fixtures[0]!.task = "mutated after validation"
  expect(checked.pack.fixtures[0]!.task).not.toBe("mutated after validation")
  expect(Object.isFrozen(checked.pack.fixtures[0])).toBe(true)
})

test("local train/dev material is not capped as a single external optimizer prompt", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const pack = makePack()
  for (const fixture of pack.fixtures) {
    const source = fixture.sources[0]!
    const previousHash = source.sha256
    source.content = source.content.padEnd(3072, " ")
    source.sha256 = sha256(source.content)
    for (const slot of fixture.outputSlots) slot.existingContent = slot.existingContent.replaceAll(previousHash, source.sha256)
  }
  const dataset = createNativeDataset({ root, selections: [{ path: selected.path }], fixturePack: pack, modelBindings: modelBindings() })
  expect(dataset.status).toBe("STRUCTURALLY_VALID")
  const projection = trainerSafeProjection(dataset)
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeGreaterThan(96 * 1024)
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(NATIVE_DATASET_LIMITS.fixtureBytes)
  expect(projection.train).toHaveLength(24)
  expect(projection.dev).toHaveLength(16)
})

test("fixture and protocol hashes are stable across object and fixture ordering", () => {
  const pack = makePack()
  const first = validateNativeFixturePack(pack)
  const reordered = clone(pack)
  reordered.fixtures.reverse()
  const second = validateNativeFixturePack(reordered)
  expect(second.packSha256).toBe(first.packSha256)

  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const manifest = createSourceManifest(root, [{ path: selected.path }])
  expect(createSourceManifest(root, [{ path: selected.path }]).manifestSha256).toBe(manifest.manifestSha256)
  expect(NATIVE_DATASET_LIMITS.fixtureBytes).toBe(512 * 1024)
  expect(NATIVE_PROTOCOL_SHA256).toMatch(/^[a-f0-9]{64}$/)
  expect(NATIVE_SKILLOPT_LIMITS).toEqual({
    targetRequests: 512,
    optimizerRequests: 40,
    reviewerRequests: 2,
    candidateSteps: 1,
    concurrency: 1,
    activeMilliseconds: 21600000,
    requestMilliseconds: 120000,
    artifactBytes: 256 * 1024 * 1024,
    fixtureBytes: 512 * 1024,
  })
})

test("initial output-slot bytes are checked, projected, and bound into fixture/projection hashes", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const baselinePack = makePack()
  const baselineHash = validateNativeFixturePack(baselinePack).packSha256
  const changedPack = clone(baselinePack)
  const trainSlot = changedPack.fixtures.find((fixture) => fixture.id === "train-0")!.outputSlots[0]!
  trainSlot.existingContent = "Prior page bytes for deterministic ownership checks."
  const changedValidation = validateNativeFixturePack(changedPack)
  expect(changedValidation.packSha256).not.toBe(baselineHash)

  const baselineDataset = createNativeDataset({ root, selections: [{ path: selected.path }], fixturePack: baselinePack, modelBindings: modelBindings() })
  const baselineProjection = trainerSafeProjection(baselineDataset)
  const dataset = createNativeDataset({ root, selections: [{ path: selected.path }], fixturePack: changedPack, modelBindings: modelBindings() })
  const projection = trainerSafeProjection(dataset)
  expect(projection.projectionSha256).not.toBe(baselineProjection.projectionSha256)
  expect(projection.train.find((fixture) => fixture.task.includes("train-0"))?.outputSlots[0]?.existingContent)
    .toBe("Prior page bytes for deterministic ownership checks.")
  expect(() => validateNativeFixturePack({
    ...clone(baselinePack),
    fixtures: baselinePack.fixtures.map((fixture) => fixture.id === "train-0"
      ? { ...fixture, outputSlots: [{ ...fixture.outputSlots[0]!, existingContent: `api_key=${"x".repeat(24)}` }] }
      : fixture),
  })).toThrow("fixture_slot_invalid")
  expect(() => validateNativeFixturePack({
    ...clone(baselinePack),
    fixtures: baselinePack.fixtures.map((fixture) => fixture.id === "train-0"
      ? { ...fixture, outputSlots: [{ ...fixture.outputSlots[0]!, existingContent: "x".repeat(NATIVE_DATASET_LIMITS.fixtureBytes + 1) }] }
      : fixture),
  })).toThrow("fixture_slot_invalid")
})

test("native model roles reject unsupported engines and same-engine reviewer bindings", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const models = modelBindings()
  const unsupported = { ...models, generator: { ...models.generator, engine: "ollama" } }
  expect(() => createNativeDataset({ root, selections: [{ path: selected.path }], fixturePack: makePack(), modelBindings: unsupported })).toThrow("unsupported_model")

  const sameReviewer = clone(modelBindings())
  sameReviewer.reviewer.engine = "codex"
  expect(() => createNativeDataset({ root, selections: [{ path: selected.path }], fixturePack: makePack(), modelBindings: sameReviewer })).toThrow("reviewer_not_independent")
})

test("versioned native profile identifiers accept dots but reject paths and control characters", () => {
  const root = tempRoot()
  const selected = sourceSelectionFixture(root)
  const input = { root, selections: [{ path: selected.path }], fixturePack: makePack() }
  const dataset = createNativeDataset({ ...input, modelBindings: modelBindings() })
  expect(dataset.modelBindings.generator.profileIdentity.id).toBe("codex-restricted-read.v1")
  expect(dataset.modelBindings.target.profileIdentity.id).toBe("claude-native-no-tools.v1")
  for (const id of ["../profile", "profile/name", "profile\nv1", "profile v1", ".".repeat(97)]) {
    const bindings = clone(modelBindings())
    bindings.generator.profileIdentity.id = id
    expect(() => createNativeDataset({ ...input, modelBindings: bindings })).toThrow("unsupported_model")
  }
})

test("model output is constrained to exact slot-addressed data, not arbitrary paths or commands", () => {
  const allowed = [{ id: "page-slot", kind: "page" as const, existingContent: "" }]
  const output = validateNativeWikiOutput({
    schema: NATIVE_WIKI_OUTPUT_SCHEMA,
    writes: [{ slotId: "page-slot", content: "A short evidence-grounded page." }],
  }, allowed)
  expect(output.writes[0]?.slotId).toBe("page-slot")
  expect(Object.isFrozen(output.writes)).toBe(true)
  expect(() => validateNativeWikiOutput({
    schema: NATIVE_WIKI_OUTPUT_SCHEMA,
    writes: [{ slotId: "page-slot", content: "data", path: "/etc/passwd" }],
  }, allowed)).toThrow("model_output_invalid")
  expect(() => validateNativeWikiOutput({
    schema: NATIVE_WIKI_OUTPUT_SCHEMA,
    writes: [{ slotId: "page-slot", content: "data", command: "rm -rf /" }],
  }, allowed)).toThrow("model_output_invalid")
})
