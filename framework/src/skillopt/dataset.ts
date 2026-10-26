import { realpathSync } from "node:fs"
import { containsSecret } from "../security/secrets.ts"
import { validModelID } from "../hosts/default-model.ts"
import { canonicalJson, NATIVE_SKILLOPT_LIMITS, PILOT_LIMITS, readBoundedSource, sha256, SkillOptError } from "./pilot.ts"

export { NATIVE_SKILLOPT_LIMITS }

export const NATIVE_WIKI_CONTRACT = "native-wiki-v1" as const
export const NATIVE_SOURCE_MANIFEST_SCHEMA = "skillopt.native-wiki-source-manifest.v1" as const
export const NATIVE_FIXTURE_PACK_SCHEMA = "skillopt.native-wiki-fixture-pack.v1" as const
export const NATIVE_DATASET_SCHEMA = "skillopt.native-wiki-dataset.v1" as const
export const NATIVE_TRAINER_PROJECTION_SCHEMA = "skillopt.native-wiki-trainer-projection.v1" as const
export const NATIVE_WIKI_OUTPUT_SCHEMA = "skillopt.native-wiki-output.v1" as const

export const NATIVE_DATASET_LIMITS = Object.freeze({
  sourceFiles: PILOT_LIMITS.sourceFiles,
  sourceBytes: PILOT_LIMITS.sourceBytes,
  sourceFileBytes: PILOT_LIMITS.sourceFileBytes,
  fixtureBytes: NATIVE_SKILLOPT_LIMITS.fixtureBytes,
  fixtureInputBytes: 64 * 1024,
  // Local train/dev projection, not an external optimizer request (which remains bounded to 96 KiB).
  trainerInputBytes: NATIVE_SKILLOPT_LIMITS.fixtureBytes,
  optimizerInputBytes: 96 * 1024,
  nativeResponseBytes: 32 * 1024,
})

export const NATIVE_WIKI_SPLITS = ["train", "dev", "final", "safety"] as const
export type NativeWikiSplit = (typeof NATIVE_WIKI_SPLITS)[number]
export const NATIVE_WIKI_SPLIT_MINIMUMS: Readonly<Record<NativeWikiSplit, number>> = Object.freeze({
  train: 24,
  dev: 16,
  final: 24,
  safety: 12,
})

export const NATIVE_WIKI_STRATA = ["citation-boundary", "correction-conflict", "dedup-resume", "ownership-injection"] as const
export type NativeWikiStratum = (typeof NATIVE_WIKI_STRATA)[number]
export const NATIVE_WIKI_OUTPUT_KINDS = ["page", "annotation", "index", "ingest", "report"] as const
export type NativeWikiOutputKind = (typeof NATIVE_WIKI_OUTPUT_KINDS)[number]
export const NATIVE_PROTECTED_CHANGES = ["raw", "source-header", "existing-log", "outside-slots"] as const
export type NativeProtectedChange = (typeof NATIVE_PROTECTED_CHANGES)[number]

export type NativeSourceProvenance = "raw" | "annotation" | "synthesis" | "contract"
export type NativeSourceSelection = Readonly<{
  path: string
  excerpt?: Readonly<{ startByte: number; endByte: number }>
}>
export type NativeSourceManifestEntry = Readonly<{
  path: string
  provenance: NativeSourceProvenance
  sourceSha256: string
  sourceBytes: number
  excerpt: Readonly<{ startByte: number; endByte: number; sha256: string; text: string }>
}>
export type NativeSourceManifest = Readonly<{
  schema: typeof NATIVE_SOURCE_MANIFEST_SCHEMA
  rootBinding: string
  entries: readonly NativeSourceManifestEntry[]
  exportSha256: string
  manifestSha256: string
}>

export type NativeModelEngine = "codex" | "claude"
export type NativeModelBinding = Readonly<{
  engine: NativeModelEngine
  requestedModel: string
  runtimeIdentity: Readonly<{ version: string; executableSha256: string }>
  profileIdentity: Readonly<{ id: string; sha256: string }>
}>
export type NativeModelBindings = Readonly<{
  generator: NativeModelBinding
  target: NativeModelBinding
  reviewer: NativeModelBinding
}>

export type NativeFixtureSource = Readonly<{
  id: string
  provenance: NativeSourceProvenance
  content: string
  sha256: string
}>
/** Initial allowlisted slot bytes; the empty string explicitly denotes a new slot. */
export type NativeWikiOutputSlot = Readonly<{ id: string; kind: NativeWikiOutputKind; existingContent: string }>
export type NativeFactAssertion = Readonly<{ id: string; slotId: string; statement: string; sourceIds: readonly string[] }>
export type NativeCitationAssertion = Readonly<{ factId: string; sourceId: string }>
export type NativeContradictionAssertion = Readonly<{
  leftFactId: string
  rightFactId: string
  expected: "retain-both" | "mark-unknown" | "prefer-correction"
}>
/** Reuse keeps the existing fixed slot/page identity; duplicate gold lines are checked per fact independently. */
export type NativeDeduplicationAssertion = Readonly<{ slotId: string; expected: "reuse-existing" | "create-new" }>
/** Preserve means no slot bytes change; append-only preserves the full initial byte prefix before appending. */
export type NativeOwnershipAssertion = Readonly<{
  slotId: string
  expected: "preserve-existing" | "append-only" | "reject-unowned"
}>
/**
 * Declarative gold is necessarily incomplete: these entries name expected evidence but do not enumerate every
 * permissible claim. An evaluator must inspect every produced fact, citation, and contradiction against the
 * fixture sources and initial slot bytes; matching these assertions alone is not semantic-completeness proof.
 */
export type NativeWikiAssertions = Readonly<{
  facts: readonly NativeFactAssertion[]
  citations: readonly NativeCitationAssertion[]
  contradictions: readonly NativeContradictionAssertion[]
  deduplication: readonly NativeDeduplicationAssertion[]
  ownership: readonly NativeOwnershipAssertion[]
}>
export type NativeWikiFixture = Readonly<{
  id: string
  familyId: string
  /** Declared source ancestry, including translated/paraphrased family equivalence across splits. */
  lineage: readonly string[]
  split: NativeWikiSplit
  stratum: NativeWikiStratum
  /** Content provenance only. It is not a human review or authorization receipt. */
  authorship: "human-authored" | "agent-authored"
  sources: readonly NativeFixtureSource[]
  /** Task must name every eligible slot as `[[slot:<id>]]`; target placement must not depend on hidden gold. */
  task: string
  outputSlots: readonly NativeWikiOutputSlot[]
  assertions: NativeWikiAssertions
  forbiddenChanges: readonly NativeProtectedChange[]
}>
export type NativeWikiFixturePack = Readonly<{
  schema: typeof NATIVE_FIXTURE_PACK_SCHEMA
  contract: typeof NATIVE_WIKI_CONTRACT
  fixtures: readonly NativeWikiFixture[]
}>

export type FixturePackRequirement = "split_minimums" | "strata_coverage"
/** Structural sufficiency only; neither status is proof of human review or authorization. */
export type NativeFixturePackValidation = Readonly<{
  status: "STRUCTURALLY_VALID" | "DATA_REQUIRED"
  pack: NativeWikiFixturePack
  packSha256: string
  packBytes: number
  coverage: Readonly<Record<NativeWikiSplit, Readonly<{ count: number; minimum: number; missingStrata: readonly NativeWikiStratum[] }>>>
  requirements: readonly FixturePackRequirement[]
}>

export type NativeDatasetRequirement = "source_selection_required" | "fixture_pack_data_required" | "trainer_input_limit"
/** Hash-bound data contract only; `STRUCTURALLY_VALID` is not consent or dispatch authority. */
export type NativeDataset = Readonly<{
  schema: typeof NATIVE_DATASET_SCHEMA
  contract: typeof NATIVE_WIKI_CONTRACT
  sourceManifest: NativeSourceManifest
  fixturePack: NativeWikiFixturePack
  modelBindings: NativeModelBindings
  sourceExportSha256: string
  fixturePackSha256: string
  protocolSha256: string
  trainerProjectionSha256: string | null
  status: "STRUCTURALLY_VALID" | "DATA_REQUIRED"
  requirements: readonly NativeDatasetRequirement[]
  datasetSha256: string
}>

export type NativeTrainerFixture = Readonly<{
  task: string
  sources: readonly NativeFixtureSource[]
  outputSlots: readonly NativeWikiOutputSlot[]
}>
export type NativeTrainerTrainFixture = NativeTrainerFixture & Readonly<{ assertions: NativeWikiAssertions }>
export type NativeTrainerProjection = Readonly<{
  schema: typeof NATIVE_TRAINER_PROJECTION_SCHEMA
  protocolSha256: string
  train: readonly NativeTrainerTrainFixture[]
  dev: readonly NativeTrainerFixture[]
  projectionSha256: string
}>
export type NativeWikiModelOutput = Readonly<{
  schema: typeof NATIVE_WIKI_OUTPUT_SCHEMA
  writes: readonly Readonly<{ slotId: string; content: string }>[]
}>

const HASH = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SOURCE_PATH = /^[A-Za-z0-9._/-]{1,512}$/
const SPLIT_SET = new Set<string>(NATIVE_WIKI_SPLITS)
const STRATUM_SET = new Set<string>(NATIVE_WIKI_STRATA)
const SOURCE_PROVENANCE_SET = new Set<string>(["raw", "annotation", "synthesis", "contract"])
const OUTPUT_KIND_SET = new Set<string>(NATIVE_WIKI_OUTPUT_KINDS)
const REQUIRED_PROTECTED_CHANGES = [...NATIVE_PROTECTED_CHANGES].sort(compareText)

const PROTOCOL_BASIS = Object.freeze({
  schema: "skillopt.native-wiki-protocol.v1",
  contract: NATIVE_WIKI_CONTRACT,
  schemas: {
    sourceManifest: NATIVE_SOURCE_MANIFEST_SCHEMA,
    sourceExport: "skillopt.native-wiki-source-export.v1",
    fixturePack: NATIVE_FIXTURE_PACK_SCHEMA,
    dataset: NATIVE_DATASET_SCHEMA,
    trainerProjection: NATIVE_TRAINER_PROJECTION_SCHEMA,
    modelOutput: NATIVE_WIKI_OUTPUT_SCHEMA,
  },
  limits: NATIVE_SKILLOPT_LIMITS,
  dataLimits: NATIVE_DATASET_LIMITS,
  splits: NATIVE_WIKI_SPLIT_MINIMUMS,
  strata: NATIVE_WIKI_STRATA,
  provenance: ["raw", "annotation", "synthesis", "contract"],
  sourceSelectionFields: ["path", "excerpt"],
  sourceExcerptFields: ["startByte", "endByte"],
  sourceManifestFields: ["schema", "rootBinding", "entries", "exportSha256", "manifestSha256"],
  sourceManifestEntryFields: ["path", "provenance", "sourceSha256", "sourceBytes", "excerpt"],
  nativeModelBindingFields: ["engine", "requestedModel", "runtimeIdentity", "profileIdentity"],
  runtimeIdentityFields: ["version", "executableSha256"],
  profileIdentityFields: ["id", "sha256"],
  fixtureFields: ["id", "familyId", "lineage", "split", "stratum", "authorship", "sources", "task", "outputSlots", "assertions", "forbiddenChanges"],
  fixtureSourceFields: ["id", "provenance", "content", "sha256"],
  outputSlotFields: ["id", "kind", "existingContent"],
  assertionFields: {
    facts: ["id", "slotId", "statement", "sourceIds"],
    citations: ["factId", "sourceId"],
    contradictions: ["leftFactId", "rightFactId", "expected"],
    deduplication: ["slotId", "expected"],
    ownership: ["slotId", "expected"],
  },
  assertionOutcomes: {
    contradictions: ["retain-both", "mark-unknown", "prefer-correction"],
    deduplication: ["reuse-existing", "create-new"],
    ownership: ["preserve-existing", "append-only", "reject-unowned"],
  },
  assertionSemantics: {
    reuseExisting: "Reuse fixed existing slot identity; check exact fact-line duplication separately and allow appending new evidence.",
    createNew: "Only when initial existingContent is empty.",
    preserveExisting: "Expected output leaves the complete slot bytes unchanged.",
    appendOnly: "Any added slot bytes follow the complete initial byte prefix unchanged.",
    rejectUnowned: "Existing slot bytes remain unchanged and the expected action is reject.",
  },
  assertionRules: {
    everyFactTargetsDeclaredSlot: true,
    factCitationAssertionsExactlyCoverSourceIds: true,
    contradictionFactsMustShareSlot: true,
  },
  authorship: ["human-authored", "agent-authored"],
  datasetFields: ["schema", "contract", "sourceManifest", "fixturePack", "modelBindings", "sourceExportSha256", "fixturePackSha256", "protocolSha256", "trainerProjectionSha256", "status", "requirements", "datasetSha256"],
  trainerProjectionFields: ["schema", "protocolSha256", "train", "dev", "projectionSha256"],
  outputKinds: NATIVE_WIKI_OUTPUT_KINDS,
  protectedChanges: REQUIRED_PROTECTED_CHANGES,
  modelOutputFields: ["schema", "writes"],
  modelOutputWriteFields: ["slotId", "content"],
})
export const NATIVE_PROTOCOL_SHA256 = sha256(canonicalJson(PROTOCOL_BASIS))

function fail(code: string): never {
  throw new SkillOptError(code)
}

function withFixedFailure<T>(code: string, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof SkillOptError) throw error
    return fail(code)
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = [], code = "invalid_data_shape"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code)
  const record = value as Record<string, unknown>
  const ownKeys = Reflect.ownKeys(record)
  const keys = Object.keys(record)
  if (ownKeys.length !== keys.length || keys.length < required.length || keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
      required.some((key) => !Object.hasOwn(record, key)) || keys.length !== required.length + optional.filter((key) => Object.hasOwn(record, key)).length) fail(code)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(code)
  }
  return record
}

function exactArray(value: unknown, code = "invalid_data_shape"): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length") || ownKeys.some((key) =>
      key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) fail(code)
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(code)
  }
  return value
}

function checkedString(value: unknown, maximumBytes: number, code: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(code)
  const bytes = Buffer.from(value, "utf8")
  if (bytes.toString("utf8") !== value || bytes.length > maximumBytes || value.includes("\0") || containsSecret(value)) fail(code)
  return value
}

function checkedHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !HASH.test(value)) fail(code)
  return value
}

function checkedInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(code)
  return value as number
}

function checkedId(value: unknown, code: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || containsSecret(value)) fail(code)
  return value
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function pathProvenance(path: string): NativeSourceProvenance {
  if (/^knowledge\/raw\/documents\/[a-f0-9]{64}\.(?:md|txt)$/.test(path)) return "raw"
  if (/^knowledge\/wiki\/sources\/documents-[a-f0-9]{64}\.md$/.test(path)) return "annotation"
  if (/^knowledge\/wiki\/(?:concepts|entities)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(path)) return "synthesis"
  if (path === "knowledge/AGENTS.md" || path === "knowledge/wiki/index.md" || path === "knowledge/wiki/log.md") return "contract"
  return fail("source_selection_not_allowed")
}

function rawSourcePathMatches(path: string, digest: string): boolean {
  return /^knowledge\/raw\/documents\/([a-f0-9]{64})\.(?:md|txt)$/.exec(path)?.[1] === digest
}

function checkedSourcePath(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_PATH.test(value) || value.includes("\\") || value.includes("\0") ||
      value.split("/").some((part) => !part || part === "." || part === "..")) fail("source_selection_not_allowed")
  return value
}

function utf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80
}

function rootBindingFor(root: string): string {
  if (typeof root !== "string" || root.length === 0) fail("source_root_invalid")
  return withFixedFailure("source_root_invalid", () => sha256(realpathSync.native(root)))
}

function sourceExportBasis(entries: readonly NativeSourceManifestEntry[]) {
  return {
    schema: "skillopt.native-wiki-source-export.v1",
    entries: entries.map((entry) => ({
      path: entry.path,
      provenance: entry.provenance,
      sourceSha256: entry.sourceSha256,
      sourceBytes: entry.sourceBytes,
      excerpt: entry.excerpt,
    })),
  }
}

function sourceManifestFromEntries(rootBinding: string, entries: readonly NativeSourceManifestEntry[]): NativeSourceManifest {
  const stableEntries = entries.map((entry) => ({
    path: entry.path,
    provenance: entry.provenance,
    sourceSha256: entry.sourceSha256,
    sourceBytes: entry.sourceBytes,
    excerpt: { ...entry.excerpt },
  }))
  const exportSha256 = sha256(canonicalJson(sourceExportBasis(stableEntries)))
  const core = { schema: NATIVE_SOURCE_MANIFEST_SCHEMA, rootBinding, entries: stableEntries, exportSha256 }
  const manifestSha256 = sha256(canonicalJson(core))
  return freezeDeep({ ...core, manifestSha256 })
}

function parseSourceExcerpt(value: unknown, code: string): NativeSourceManifestEntry["excerpt"] {
  const record = exactObject(value, ["startByte", "endByte", "sha256", "text"], [], code)
  const startByte = checkedInteger(record.startByte, 0, NATIVE_DATASET_LIMITS.sourceFileBytes, code)
  const endByte = checkedInteger(record.endByte, 1, NATIVE_DATASET_LIMITS.sourceFileBytes, code)
  const text = checkedString(record.text, NATIVE_DATASET_LIMITS.sourceFileBytes, code)
  if (endByte <= startByte || Buffer.byteLength(text, "utf8") !== endByte - startByte) fail(code)
  const digest = checkedHash(record.sha256, code)
  if (sha256(Buffer.from(text, "utf8")) !== digest) fail("source_manifest_digest_mismatch")
  return { startByte, endByte, sha256: digest, text }
}

function parseSourceManifest(value: unknown): NativeSourceManifest {
  return withFixedFailure("source_manifest_invalid", () => {
    const record = exactObject(value, ["schema", "rootBinding", "entries", "exportSha256", "manifestSha256"], [], "source_manifest_invalid")
    if (record.schema !== NATIVE_SOURCE_MANIFEST_SCHEMA) fail("source_manifest_invalid")
    const rootBinding = checkedHash(record.rootBinding, "source_manifest_invalid")
    const rawEntries = exactArray(record.entries, "source_manifest_invalid")
    if (rawEntries.length > NATIVE_DATASET_LIMITS.sourceFiles) fail("source_limit")
    const entries: NativeSourceManifestEntry[] = []
    const seenPaths = new Set<string>()
    let totalBytes = 0
    for (const rawEntry of rawEntries) {
      const entry = exactObject(rawEntry, ["path", "provenance", "sourceSha256", "sourceBytes", "excerpt"], [], "source_manifest_invalid")
      const path = checkedSourcePath(entry.path)
      const provenance = pathProvenance(path)
      if (entry.provenance !== provenance || seenPaths.has(path)) fail("source_manifest_invalid")
      seenPaths.add(path)
      const sourceSha256 = checkedHash(entry.sourceSha256, "source_manifest_invalid")
      const sourceBytes = checkedInteger(entry.sourceBytes, 1, NATIVE_DATASET_LIMITS.sourceFileBytes, "source_manifest_invalid")
      const excerpt = parseSourceExcerpt(entry.excerpt, "source_manifest_invalid")
      if (excerpt.endByte > sourceBytes) fail("source_manifest_invalid")
      if (provenance === "raw" && !rawSourcePathMatches(path, sourceSha256)) fail("source_digest_mismatch")
      totalBytes += sourceBytes
      if (totalBytes > NATIVE_DATASET_LIMITS.sourceBytes) fail("source_limit")
      entries.push({ path, provenance, sourceSha256, sourceBytes, excerpt })
    }
    const expected = sourceManifestFromEntries(rootBinding, entries)
    if (record.exportSha256 !== expected.exportSha256 || record.manifestSha256 !== expected.manifestSha256) fail("source_manifest_digest_mismatch")
    if (Buffer.byteLength(canonicalJson(sourceExportBasis(entries)), "utf8") > NATIVE_DATASET_LIMITS.sourceBytes) fail("source_limit")
    return expected
  })
}

/** Builds a deterministic manifest from only the explicitly selected, allowlisted source files. */
export function createSourceManifest(root: string, selections: readonly NativeSourceSelection[] = []): NativeSourceManifest {
  return withFixedFailure("source_manifest_invalid", () => {
    const rootBinding = rootBindingFor(root)
    const rawSelections = exactArray(selections, "source_selection_invalid")
    if (rawSelections.length > NATIVE_DATASET_LIMITS.sourceFiles) fail("source_limit")
    const normalized = rawSelections.map((value) => {
      const record = exactObject(value, ["path"], ["excerpt"], "source_selection_invalid")
      const path = checkedSourcePath(record.path)
      const provenance = pathProvenance(path)
      let excerpt: { startByte: number; endByte: number } | undefined
      if (Object.hasOwn(record, "excerpt")) {
        const range = exactObject(record.excerpt, ["startByte", "endByte"], [], "source_selection_invalid")
        excerpt = {
          startByte: checkedInteger(range.startByte, 0, NATIVE_DATASET_LIMITS.sourceFileBytes, "source_selection_invalid"),
          endByte: checkedInteger(range.endByte, 1, NATIVE_DATASET_LIMITS.sourceFileBytes, "source_selection_invalid"),
        }
        if (excerpt.endByte <= excerpt.startByte) fail("source_excerpt_invalid")
      }
      return { path, provenance, excerpt }
    }).sort((left, right) => compareText(left.path, right.path))
    const seenPaths = new Set<string>()
    const entries: NativeSourceManifestEntry[] = []
    let totalBytes = 0
    for (const selection of normalized) {
      if (seenPaths.has(selection.path)) fail("source_selection_duplicate")
      seenPaths.add(selection.path)
      let bytes: Buffer
      try {
        bytes = readBoundedSource(root, selection.path, NATIVE_DATASET_LIMITS.sourceFileBytes)
      } catch (error) {
        if (error instanceof SkillOptError) throw error
        return fail("source_unavailable")
      }
      const sourceSha256 = sha256(bytes)
      if (selection.provenance === "raw" && !rawSourcePathMatches(selection.path, sourceSha256)) fail("source_digest_mismatch")
      totalBytes += bytes.length
      if (totalBytes > NATIVE_DATASET_LIMITS.sourceBytes) fail("source_limit")
      const range = selection.excerpt ?? { startByte: 0, endByte: bytes.length }
      if (range.endByte > bytes.length || !utf8Boundary(bytes, range.startByte) || !utf8Boundary(bytes, range.endByte)) fail("source_excerpt_boundary")
      const excerptBytes = bytes.subarray(range.startByte, range.endByte)
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(excerptBytes)
      } catch {
        return fail("source_excerpt_encoding")
      }
      if (text.includes("\0") || containsSecret(text)) fail("source_sensitive_or_invalid")
      entries.push({
        path: selection.path,
        provenance: selection.provenance,
        sourceSha256,
        sourceBytes: bytes.length,
        excerpt: { startByte: range.startByte, endByte: range.endByte, sha256: sha256(excerptBytes), text },
      })
    }
    const manifest = sourceManifestFromEntries(rootBinding, entries)
    if (Buffer.byteLength(canonicalJson(sourceExportBasis(manifest.entries)), "utf8") > NATIVE_DATASET_LIMITS.sourceBytes) fail("source_limit")
    return manifest
  })
}

/** Re-reads every selected file and refuses any source/root/excerpt drift. */
export function validateSourceManifest(root: string, value: unknown): NativeSourceManifest {
  return withFixedFailure("source_manifest_invalid", () => {
    const supplied = parseSourceManifest(value)
    if (rootBindingFor(root) !== supplied.rootBinding) fail("source_root_mismatch")
    const selections = supplied.entries.map((entry) => ({
      path: entry.path,
      excerpt: { startByte: entry.excerpt.startByte, endByte: entry.excerpt.endByte },
    }))
    const current = createSourceManifest(root, selections)
    if (canonicalJson(current) !== canonicalJson(supplied)) fail("source_digest_mismatch")
    return current
  })
}

function parseModelBinding(value: unknown): NativeModelBinding {
  const record = exactObject(value, ["engine", "requestedModel", "runtimeIdentity", "profileIdentity"], [], "unsupported_model")
  if (record.engine !== "codex" && record.engine !== "claude") fail("unsupported_model")
  const requestedModel = checkedString(record.requestedModel, 256, "unsupported_model")
  if (!validModelID(requestedModel)) fail("unsupported_model")
  const runtime = exactObject(record.runtimeIdentity, ["version", "executableSha256"], [], "unsupported_model")
  const profile = exactObject(record.profileIdentity, ["id", "sha256"], [], "unsupported_model")
  const version = checkedString(runtime.version, 128, "unsupported_model")
  const executableSha256 = checkedHash(runtime.executableSha256, "unsupported_model")
  const id = checkedString(profile.id, 96, "unsupported_model")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(id)) fail("unsupported_model")
  const profileSha256 = checkedHash(profile.sha256, "unsupported_model")
  return {
    engine: record.engine as NativeModelEngine,
    requestedModel,
    runtimeIdentity: { version, executableSha256 },
    profileIdentity: { id, sha256: profileSha256 },
  }
}

function parseModelBindings(value: unknown): NativeModelBindings {
  const record = exactObject(value, ["generator", "target", "reviewer"], [], "unsupported_model")
  const generator = parseModelBinding(record.generator)
  const target = parseModelBinding(record.target)
  const reviewer = parseModelBinding(record.reviewer)
  if (generator.engine === reviewer.engine) fail("reviewer_not_independent")
  return freezeDeep({ generator, target, reviewer })
}

function isSessionDigestSnapshot(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "session-digest-snapshot"
  } catch {
    return false
  }
}

function parseFixtureSource(value: unknown): NativeFixtureSource {
  const record = exactObject(value, ["id", "provenance", "content", "sha256"], [], "fixture_pack_invalid")
  const id = checkedId(record.id, "fixture_pack_invalid")
  if (typeof record.provenance !== "string" || !SOURCE_PROVENANCE_SET.has(record.provenance)) fail("fixture_pack_invalid")
  const content = checkedString(record.content, NATIVE_DATASET_LIMITS.sourceFileBytes, "fixture_pack_invalid")
  if (isSessionDigestSnapshot(content)) fail("metadata_only_source")
  const digest = checkedHash(record.sha256, "fixture_pack_invalid")
  if (sha256(Buffer.from(content, "utf8")) !== digest) fail("fixture_source_digest_mismatch")
  return { id, provenance: record.provenance as NativeSourceProvenance, content, sha256: digest }
}

function parseOutputSlot(value: unknown): NativeWikiOutputSlot {
  const record = exactObject(value, ["id", "kind", "existingContent"], [], "fixture_slot_invalid")
  const id = checkedId(record.id, "fixture_pack_invalid")
  if (typeof record.kind !== "string" || !OUTPUT_KIND_SET.has(record.kind)) fail("fixture_slot_invalid")
  const existingContent = checkedString(record.existingContent, NATIVE_DATASET_LIMITS.fixtureBytes, "fixture_slot_invalid", true)
  return { id, kind: record.kind as NativeWikiOutputKind, existingContent }
}

function parseAssertions(value: unknown, sourceIds: ReadonlySet<string>, outputSlots: ReadonlyMap<string, NativeWikiOutputSlot>): NativeWikiAssertions {
  const record = exactObject(value, ["facts", "citations", "contradictions", "deduplication", "ownership"], [], "fixture_pack_invalid")
  const facts = exactArray(record.facts, "fixture_pack_invalid").map((raw) => {
    const fact = exactObject(raw, ["id", "slotId", "statement", "sourceIds"], [], "fixture_pack_invalid")
    const id = checkedId(fact.id, "fixture_pack_invalid")
    const slotId = checkedId(fact.slotId, "fixture_pack_invalid")
    if (!outputSlots.has(slotId)) fail("fixture_assertion_invalid")
    const statement = checkedString(fact.statement, NATIVE_DATASET_LIMITS.fixtureBytes, "fixture_pack_invalid")
    if (isSessionDigestSnapshot(statement)) fail("metadata_only_source")
    const rawSourceIds = exactArray(fact.sourceIds, "fixture_pack_invalid")
    if (rawSourceIds.length === 0) fail("fixture_assertion_invalid")
    const ids = rawSourceIds.map((sourceId) => checkedId(sourceId, "fixture_pack_invalid")).sort(compareText)
    if (new Set(ids).size !== ids.length || ids.some((sourceId) => !sourceIds.has(sourceId))) fail("fixture_assertion_invalid")
    return { id, slotId, statement, sourceIds: ids }
  }).sort((left, right) => compareText(left.id, right.id))
  const factIds = new Set(facts.map((fact) => fact.id))
  if (factIds.size !== facts.length || facts.length === 0) fail("fixture_assertion_invalid")

  const citations = exactArray(record.citations, "fixture_pack_invalid").map((raw) => {
    const citation = exactObject(raw, ["factId", "sourceId"], [], "fixture_pack_invalid")
    const factId = checkedId(citation.factId, "fixture_pack_invalid")
    const sourceId = checkedId(citation.sourceId, "fixture_pack_invalid")
    const fact = facts.find((item) => item.id === factId)
    if (!fact || !fact.sourceIds.includes(sourceId)) fail("fixture_assertion_invalid")
    return { factId, sourceId }
  }).sort((left, right) => compareText(`${left.factId}:${left.sourceId}`, `${right.factId}:${right.sourceId}`))
  if (citations.length === 0 || new Set(citations.map((item) => `${item.factId}:${item.sourceId}`)).size !== citations.length) fail("fixture_assertion_invalid")
  for (const fact of facts) {
    const declared = citations.filter((citation) => citation.factId === fact.id).map((citation) => citation.sourceId).sort(compareText)
    if (declared.length !== fact.sourceIds.length || declared.some((sourceId, index) => sourceId !== fact.sourceIds[index])) fail("fixture_assertion_invalid")
  }

  const contradictions = exactArray(record.contradictions, "fixture_pack_invalid").map((raw) => {
    const item = exactObject(raw, ["leftFactId", "rightFactId", "expected"], [], "fixture_pack_invalid")
    const leftFactId = checkedId(item.leftFactId, "fixture_pack_invalid")
    const rightFactId = checkedId(item.rightFactId, "fixture_pack_invalid")
    const leftFact = facts.find((fact) => fact.id === leftFactId)
    const rightFact = facts.find((fact) => fact.id === rightFactId)
    if (leftFactId === rightFactId || !leftFact || !rightFact || leftFact.slotId !== rightFact.slotId || typeof item.expected !== "string" ||
        !["retain-both", "mark-unknown", "prefer-correction"].includes(item.expected)) fail("fixture_assertion_invalid")
    return { leftFactId, rightFactId, expected: item.expected as NativeContradictionAssertion["expected"] }
  }).sort((left, right) => compareText(`${left.leftFactId}:${left.rightFactId}:${left.expected}`, `${right.leftFactId}:${right.rightFactId}:${right.expected}`))
  if (new Set(contradictions.map((item) => `${item.leftFactId}:${item.rightFactId}`)).size !== contradictions.length) fail("fixture_assertion_invalid")

  const deduplication = exactArray(record.deduplication, "fixture_pack_invalid").map((raw) => {
    const item = exactObject(raw, ["slotId", "expected"], [], "fixture_pack_invalid")
    const slotId = checkedId(item.slotId, "fixture_pack_invalid")
    if (!outputSlots.has(slotId) || typeof item.expected !== "string" || !["reuse-existing", "create-new"].includes(item.expected)) fail("fixture_assertion_invalid")
    const expected = item.expected as NativeDeduplicationAssertion["expected"]
    const existingContent = outputSlots.get(slotId)!.existingContent
    if ((expected === "reuse-existing" && existingContent.length === 0) || (expected === "create-new" && existingContent.length > 0)) fail("fixture_assertion_invalid")
    return { slotId, expected }
  }).sort((left, right) => compareText(left.slotId, right.slotId))
  if (new Set(deduplication.map((item) => item.slotId)).size !== deduplication.length) fail("fixture_assertion_invalid")

  const ownership = exactArray(record.ownership, "fixture_pack_invalid").map((raw) => {
    const item = exactObject(raw, ["slotId", "expected"], [], "fixture_pack_invalid")
    const slotId = checkedId(item.slotId, "fixture_pack_invalid")
    if (!outputSlots.has(slotId) || typeof item.expected !== "string" || !["preserve-existing", "append-only", "reject-unowned"].includes(item.expected)) fail("fixture_assertion_invalid")
    const expected = item.expected as NativeOwnershipAssertion["expected"]
    if (expected !== "reject-unowned" && outputSlots.get(slotId)!.existingContent.length === 0) fail("fixture_assertion_invalid")
    return { slotId, expected }
  }).sort((left, right) => compareText(`${left.slotId}:${left.expected}`, `${right.slotId}:${right.expected}`))
  if (new Set(ownership.map((item) => item.slotId)).size !== ownership.length) fail("fixture_assertion_invalid")

  return { facts, citations, contradictions, deduplication, ownership }
}

function fixtureInputBasis(fixture: NativeWikiFixture) {
  return {
    task: fixture.task,
    sources: fixture.sources,
    outputSlots: fixture.outputSlots,
  }
}

function parseFixture(value: unknown): NativeWikiFixture {
  const record = exactObject(value, ["id", "familyId", "lineage", "split", "stratum", "authorship", "sources", "task", "outputSlots", "assertions", "forbiddenChanges"], [], "fixture_pack_invalid")
  const id = checkedId(record.id, "fixture_pack_invalid")
  const familyId = checkedId(record.familyId, "fixture_pack_invalid")
  if (typeof record.split !== "string" || !SPLIT_SET.has(record.split) || typeof record.stratum !== "string" || !STRATUM_SET.has(record.stratum)) fail("fixture_pack_invalid")
  if (record.authorship !== "human-authored" && record.authorship !== "agent-authored") fail("fixture_pack_invalid")
  const lineage = exactArray(record.lineage, "fixture_pack_invalid").map((item) => checkedId(item, "fixture_pack_invalid")).sort(compareText)
  if (lineage.length === 0 || new Set(lineage).size !== lineage.length) fail("fixture_lineage_invalid")
  const sources = exactArray(record.sources, "fixture_pack_invalid").map(parseFixtureSource).sort((left, right) => compareText(left.id, right.id))
  if (sources.length === 0 || new Set(sources.map((source) => source.id)).size !== sources.length || new Set(sources.map((source) => source.sha256)).size !== sources.length) fail("fixture_source_invalid")
  const task = checkedString(record.task, NATIVE_DATASET_LIMITS.fixtureBytes, "fixture_pack_invalid")
  if (isSessionDigestSnapshot(task)) fail("metadata_only_source")
  const outputSlots = exactArray(record.outputSlots, "fixture_pack_invalid").map(parseOutputSlot).sort((left, right) => compareText(left.id, right.id))
  if (outputSlots.length === 0 || new Set(outputSlots.map((slot) => slot.id)).size !== outputSlots.length) fail("fixture_slot_invalid")
  const assertions = parseAssertions(record.assertions, new Set(sources.map((source) => source.id)), new Map(outputSlots.map((slot) => [slot.id, slot])))
  const forbiddenChanges = exactArray(record.forbiddenChanges, "fixture_pack_invalid").map((item) => {
    if (typeof item !== "string" || !(NATIVE_PROTECTED_CHANGES as readonly string[]).includes(item)) fail("fixture_pack_invalid")
    return item as NativeProtectedChange
  }).sort(compareText)
  if (forbiddenChanges.length !== REQUIRED_PROTECTED_CHANGES.length || forbiddenChanges.some((item, index) => item !== REQUIRED_PROTECTED_CHANGES[index])) fail("fixture_protected_changes_invalid")
  const fixture: NativeWikiFixture = {
    id,
    familyId,
    lineage,
    split: record.split as NativeWikiSplit,
    stratum: record.stratum as NativeWikiStratum,
    authorship: record.authorship as NativeWikiFixture["authorship"],
    sources,
    task,
    outputSlots,
    assertions,
    forbiddenChanges,
  }
  if (Buffer.byteLength(canonicalJson(fixtureInputBasis(fixture)), "utf8") > NATIVE_DATASET_LIMITS.fixtureInputBytes) fail("fixture_input_limit")
  return fixture
}

function fixtureCoverage(fixtures: readonly NativeWikiFixture[]) {
  const coverage = {} as Record<NativeWikiSplit, { count: number; minimum: number; missingStrata: NativeWikiStratum[] }>
  for (const split of NATIVE_WIKI_SPLITS) {
    const members = fixtures.filter((fixture) => fixture.split === split)
    const present = new Set(members.map((fixture) => fixture.stratum))
    coverage[split] = {
      count: members.length,
      minimum: NATIVE_WIKI_SPLIT_MINIMUMS[split],
      missingStrata: NATIVE_WIKI_STRATA.filter((stratum) => !present.has(stratum)),
    }
  }
  return coverage
}

function parseFixturePack(value: unknown): NativeFixturePackValidation {
  return withFixedFailure("fixture_pack_invalid", () => {
    const record = exactObject(value, ["schema", "contract", "fixtures"], [], "fixture_pack_invalid")
    if (record.schema !== NATIVE_FIXTURE_PACK_SCHEMA || record.contract !== NATIVE_WIKI_CONTRACT) fail("fixture_pack_invalid")
    const rawFixtures = exactArray(record.fixtures, "fixture_pack_invalid")
    const fixtures = rawFixtures.map(parseFixture).sort((left, right) => compareText(left.id, right.id))
    if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) fail("fixture_id_duplicate")
    const familyIds = new Set<string>()
    const lineageOwners = new Map<string, string>()
    const sourceHashes = new Set<string>()
    for (const fixture of fixtures) {
      if (familyIds.has(fixture.familyId)) fail("fixture_family_reuse")
      familyIds.add(fixture.familyId)
      for (const lineage of fixture.lineage) {
        const previous = lineageOwners.get(lineage)
        if (previous !== undefined && previous !== fixture.id) fail("fixture_lineage_reuse")
        lineageOwners.set(lineage, fixture.id)
      }
      for (const source of fixture.sources) {
        if (sourceHashes.has(source.sha256)) fail("fixture_source_content_reuse")
        sourceHashes.add(source.sha256)
      }
      if (fixture.stratum === "correction-conflict" && fixture.assertions.contradictions.length === 0) fail("fixture_assertion_invalid")
      if (fixture.stratum === "dedup-resume" && fixture.assertions.deduplication.length === 0) fail("fixture_assertion_invalid")
      if (fixture.stratum === "ownership-injection" && fixture.assertions.ownership.length === 0) fail("fixture_assertion_invalid")
    }
    const pack: NativeWikiFixturePack = freezeDeep({
      schema: NATIVE_FIXTURE_PACK_SCHEMA,
      contract: NATIVE_WIKI_CONTRACT,
      fixtures,
    })
    const packText = canonicalJson(pack)
    const packBytes = Buffer.byteLength(packText, "utf8")
    if (packBytes > NATIVE_DATASET_LIMITS.fixtureBytes) fail("fixture_pack_limit")
    const coverage = fixtureCoverage(fixtures)
    const requirements: FixturePackRequirement[] = []
    if (NATIVE_WIKI_SPLITS.some((split) => coverage[split].count < coverage[split].minimum)) requirements.push("split_minimums")
    if (NATIVE_WIKI_SPLITS.some((split) => coverage[split].missingStrata.length > 0)) requirements.push("strata_coverage")
    return freezeDeep({
      status: requirements.length === 0 ? "STRUCTURALLY_VALID" : "DATA_REQUIRED",
      pack,
      packSha256: sha256(packText),
      packBytes,
      coverage,
      requirements,
    })
  })
}

/** Structural validation only. This result is never an approval or authorization receipt. */
export function validateNativeFixturePack(value: unknown): NativeFixturePackValidation {
  return parseFixturePack(value)
}

function trainerProjectionBasis(pack: NativeWikiFixturePack) {
  const inputFor = (fixture: NativeWikiFixture) => ({
    task: fixture.task,
    sources: fixture.sources.map((source) => ({ ...source })),
    outputSlots: fixture.outputSlots.map((slot) => ({ ...slot })),
  })
  return {
    schema: NATIVE_TRAINER_PROJECTION_SCHEMA,
    protocolSha256: NATIVE_PROTOCOL_SHA256,
    train: pack.fixtures.filter((fixture) => fixture.split === "train").map((fixture) => ({
      ...inputFor(fixture),
      assertions: {
        facts: fixture.assertions.facts.map((item) => ({ ...item, sourceIds: [...item.sourceIds] })),
        citations: fixture.assertions.citations.map((item) => ({ ...item })),
        contradictions: fixture.assertions.contradictions.map((item) => ({ ...item })),
        deduplication: fixture.assertions.deduplication.map((item) => ({ ...item })),
        ownership: fixture.assertions.ownership.map((item) => ({ ...item })),
      },
    })),
    dev: pack.fixtures.filter((fixture) => fixture.split === "dev").map(inputFor),
  }
}

function nativeDatasetBasis(value: Omit<NativeDataset, "datasetSha256">) {
  return {
    schema: value.schema,
    contract: value.contract,
    sourceManifest: value.sourceManifest,
    fixturePack: value.fixturePack,
    modelBindings: value.modelBindings,
    sourceExportSha256: value.sourceExportSha256,
    fixturePackSha256: value.fixturePackSha256,
    protocolSha256: value.protocolSha256,
    trainerProjectionSha256: value.trainerProjectionSha256,
    status: value.status,
    requirements: value.requirements,
  }
}

function assembleNativeDataset(sourceManifest: NativeSourceManifest, fixtureValidation: NativeFixturePackValidation, modelBindings: NativeModelBindings): NativeDataset {
  const requirements: NativeDatasetRequirement[] = []
  if (sourceManifest.entries.length === 0) requirements.push("source_selection_required")
  if (fixtureValidation.status === "DATA_REQUIRED") requirements.push("fixture_pack_data_required")
  let trainerProjectionSha256: string | null = null
  if (fixtureValidation.status === "STRUCTURALLY_VALID") {
    const projection = trainerProjectionBasis(fixtureValidation.pack)
    if (Buffer.byteLength(canonicalJson(projection), "utf8") <= NATIVE_DATASET_LIMITS.trainerInputBytes) {
      trainerProjectionSha256 = sha256(canonicalJson(projection))
    } else {
      requirements.push("trainer_input_limit")
    }
  }
  const core = {
    schema: NATIVE_DATASET_SCHEMA,
    contract: NATIVE_WIKI_CONTRACT,
    sourceManifest,
    fixturePack: fixtureValidation.pack,
    modelBindings,
    sourceExportSha256: sourceManifest.exportSha256,
    fixturePackSha256: fixtureValidation.packSha256,
    protocolSha256: NATIVE_PROTOCOL_SHA256,
    trainerProjectionSha256,
    status: requirements.length === 0 ? "STRUCTURALLY_VALID" as const : "DATA_REQUIRED" as const,
    requirements,
  }
  const datasetSha256 = sha256(canonicalJson(nativeDatasetBasis(core)))
  return freezeDeep({ ...core, datasetSha256 })
}

/** Creates a hash-bound, read-only dataset description; it performs no authorization or inference. */
export function createNativeDataset(input: Readonly<{
  root: string
  selections?: readonly NativeSourceSelection[]
  fixturePack: unknown
  modelBindings: unknown
}>): NativeDataset {
  return withFixedFailure("dataset_invalid", () => {
    const record = exactObject(input, ["root", "fixturePack", "modelBindings"], ["selections"], "dataset_invalid")
    if (typeof record.root !== "string" || record.root.length === 0) fail("source_root_invalid")
    const selections = Object.hasOwn(record, "selections") ? record.selections as readonly NativeSourceSelection[] : []
    const sourceManifest = createSourceManifest(record.root, selections)
    const fixtureValidation = validateNativeFixturePack(record.fixturePack)
    const modelBindings = parseModelBindings(record.modelBindings)
    return assembleNativeDataset(sourceManifest, fixtureValidation, modelBindings)
  })
}

/** Revalidates a dataset against current selected source bytes and every embedded digest. */
export function validateNativeDataset(root: string, value: unknown): NativeDataset {
  return withFixedFailure("dataset_invalid", () => {
    const record = exactObject(value, ["schema", "contract", "sourceManifest", "fixturePack", "modelBindings", "sourceExportSha256", "fixturePackSha256", "protocolSha256", "trainerProjectionSha256", "status", "requirements", "datasetSha256"], [], "dataset_invalid")
    if (record.schema !== NATIVE_DATASET_SCHEMA || record.contract !== NATIVE_WIKI_CONTRACT) fail("dataset_invalid")
    const sourceManifest = validateSourceManifest(root, record.sourceManifest)
    const fixtureValidation = validateNativeFixturePack(record.fixturePack)
    const modelBindings = parseModelBindings(record.modelBindings)
    const expected = assembleNativeDataset(sourceManifest, fixtureValidation, modelBindings)
    if (canonicalJson(expected) !== canonicalJson(value)) fail("dataset_digest_mismatch")
    return expected
  })
}

function validateDatasetInternals(value: NativeDataset): NativeDataset {
  const record = exactObject(value, ["schema", "contract", "sourceManifest", "fixturePack", "modelBindings", "sourceExportSha256", "fixturePackSha256", "protocolSha256", "trainerProjectionSha256", "status", "requirements", "datasetSha256"], [], "dataset_invalid")
  if (record.schema !== NATIVE_DATASET_SCHEMA || record.contract !== NATIVE_WIKI_CONTRACT || record.protocolSha256 !== NATIVE_PROTOCOL_SHA256) fail("dataset_digest_mismatch")
  const sourceManifest = parseSourceManifest(record.sourceManifest)
  const fixtureValidation = validateNativeFixturePack(record.fixturePack)
  const modelBindings = parseModelBindings(record.modelBindings)
  const expected = assembleNativeDataset(sourceManifest, fixtureValidation, modelBindings)
  if (canonicalJson(expected) !== canonicalJson(value)) fail("dataset_digest_mismatch")
  return expected
}

/** Returns only train inputs+assertions and dev inputs. Final/safety IDs and gold are never copied. */
export function trainerSafeProjection(dataset: NativeDataset): NativeTrainerProjection {
  const validated = validateDatasetInternals(dataset)
  if (validated.status !== "STRUCTURALLY_VALID" || validated.trainerProjectionSha256 === null) fail("data_required")
  const core = trainerProjectionBasis(validated.fixturePack)
  const encoded = canonicalJson(core)
  if (Buffer.byteLength(encoded, "utf8") > NATIVE_DATASET_LIMITS.trainerInputBytes) fail("trainer_input_limit")
  if (sha256(encoded) !== validated.trainerProjectionSha256) fail("dataset_digest_mismatch")
  return freezeDeep({ ...core, projectionSha256: validated.trainerProjectionSha256 })
}

/** Validates inert, slot-addressed text data. The schema has no command or filesystem-path field. */
export function validateNativeWikiOutput(value: unknown, allowedSlots: readonly NativeWikiOutputSlot[]): NativeWikiModelOutput {
  return withFixedFailure("model_output_invalid", () => {
    const record = exactObject(value, ["schema", "writes"], [], "model_output_invalid")
    if (record.schema !== NATIVE_WIKI_OUTPUT_SCHEMA) fail("model_output_invalid")
    const rawSlots = exactArray(allowedSlots, "model_output_invalid").map(parseOutputSlot)
    const allowed = new Set(rawSlots.map((slot) => slot.id))
    if (allowed.size !== rawSlots.length || allowed.size === 0) fail("model_output_invalid")
    const writes = exactArray(record.writes, "model_output_invalid").map((raw) => {
      const write = exactObject(raw, ["slotId", "content"], [], "model_output_invalid")
      const slotId = checkedId(write.slotId, "model_output_invalid")
      const content = checkedString(write.content, NATIVE_DATASET_LIMITS.nativeResponseBytes, "model_output_invalid", true)
      if (!allowed.has(slotId)) fail("model_output_invalid")
      return { slotId, content }
    }).sort((left, right) => compareText(left.slotId, right.slotId))
    if (writes.length !== allowed.size || new Set(writes.map((write) => write.slotId)).size !== writes.length) fail("model_output_invalid")
    const output: NativeWikiModelOutput = { schema: NATIVE_WIKI_OUTPUT_SCHEMA, writes }
    if (Buffer.byteLength(canonicalJson(output), "utf8") > NATIVE_DATASET_LIMITS.nativeResponseBytes) fail("model_output_limit")
    return freezeDeep(output)
  })
}
