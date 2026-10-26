import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import {
  NATIVE_DATASET_LIMITS, NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT, NATIVE_WIKI_OUTPUT_SCHEMA,
  NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_STRATA, type NativeWikiFixture, type NativeWikiFixturePack,
} from "../src/skillopt/dataset.ts"
import {
  buildNativeEvaluationPrompt, measureNativeQualification, NATIVE_EVALUATION_PROTOCOL_SHA256,
  NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA, nativeEvaluationInput, planNativeFixtureSerializedWrites, runNativeFixtureAdapter,
  renderNativeEvaluationPrompt, scoreNativeEvaluationTrial, scoreNativeFixtureResponse, serializeNativeFixtureWorkerInput,
  validateNativeFixtureGold, validateNativeFixtureWorkspace, type NativeEvaluationTrial, type NativeWikiReferenceAnswer,
} from "../src/skillopt/evaluation.ts"
import { canonicalJson, sha256 } from "../src/skillopt/pilot.ts"

// Synthetic unit-test data only: this is neither human-approved data nor a live optimization result.
function pack(): NativeWikiFixturePack {
  const fixtures: NativeWikiFixture[] = []
  for (const [split, count] of Object.entries(NATIVE_WIKI_SPLIT_MINIMUMS)) {
    for (let index = 0; index < count; index++) {
      const id = `${split}-${index}`
      const original = `The original observation for ${id}.`
      const correction = `The correction for ${id}.`
      const content = `${original}\n${correction}\n`
      const sourceHash = sha256(content)
      const factLine = (statement: string) => `- ${escapeMarkdown(statement)} ([source](../sources/documents-${sourceHash}.md))`
      const [conflictLeft, conflictRight] = [original, correction].sort()
      const conflictLine = `- ${escapeMarkdown(conflictLeft)} ↔ ${escapeMarkdown(conflictRight)} — retain-both.`
      const stratum = NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!
      const existingContent = stratum === "dedup-resume"
        ? `${factLine(original)}\n`
        : stratum === "ownership-injection"
          ? `${factLine(original)}\n${factLine(correction)}\n${conflictLine}\n`
          : "Previous observation.\n"
      fixtures.push({
        id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split: split as NativeWikiFixture["split"],
        stratum, authorship: "agent-authored",
        sources: [{ id: "source", provenance: "raw", content, sha256: sourceHash }],
        task: `Integrate the observations for ${id} in [[slot:page]] and preserve the previous report.`,
        outputSlots: [{ id: "page", kind: "page", existingContent }],
        assertions: {
          facts: [
            { id: "original", slotId: "page", statement: original, sourceIds: ["source"] },
            { id: "correction", slotId: "page", statement: correction, sourceIds: ["source"] },
          ],
          citations: [{ factId: "original", sourceId: "source" }, { factId: "correction", sourceId: "source" }],
          contradictions: [{ leftFactId: "original", rightFactId: "correction", expected: "retain-both" }],
          deduplication: [{ slotId: "page", expected: "reuse-existing" }],
          ownership: [{ slotId: "page", expected: stratum === "ownership-injection" ? "preserve-existing" : "append-only" }],
        },
        forbiddenChanges: [...NATIVE_PROTECTED_CHANGES],
      })
    }
  }
  return { schema: NATIVE_FIXTURE_PACK_SCHEMA, contract: NATIVE_WIKI_CONTRACT, fixtures }
}

function trials(fixturePack: NativeWikiFixturePack): NativeEvaluationTrial[] {
  return fixturePack.fixtures.filter(fixture => fixture.split !== "train").flatMap(fixture =>
    (["baseline", "candidate"] as const).flatMap(variant => [0, 1, 2].map(repeat => ({
      fixtureId: fixture.id, variant, repeat, status: "valid" as const, hardPass: variant === "candidate",
      latencyMs: 100, outputSha256: sha256(`${fixture.id}:${variant}:${repeat}`),
    }))))
}

function measure(fixturePack = pack(), records = trials(fixturePack)) {
  return measureNativeQualification({ fixturePack, baselineSha256: "a".repeat(64), candidateSha256: "b".repeat(64), trials: records })
}

const scratchRoots: string[] = []
function scratchRoot(prefix = "otter-skillopt-fixture-"): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  scratchRoots.push(path)
  return path
}

function captureSerializedWrites<T>(root: string | { directoryPrefix: string }, operation: () => T): { result: T; writes: { bytes: number; sha256: string }[] } {
  const writes: { bytes: number; sha256: string }[] = []
  const realWriteFileSync = nodeFs.writeFileSync
  const spy = spyOn(nodeFs, "writeFileSync").mockImplementation((...args) => {
    const [path, data] = args
    const pathText = typeof path === "string" ? path : path.toString()
    const matches = typeof root === "string"
      ? pathText === root || pathText.startsWith(`${root}/`)
      : pathText.startsWith(root.directoryPrefix) && pathText.indexOf("/", root.directoryPrefix.length) !== -1
    if (matches) {
      const bytes = typeof data === "string"
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      writes.push({ bytes: bytes.byteLength, sha256: sha256(bytes) })
    }
    return Reflect.apply(realWriteFileSync, nodeFs, args)
  })
  try { return { result: operation(), writes } }
  finally { spy.mockRestore() }
}

function captureFilesystemWrites<T>(operation: () => T): { result: T; writes: string[] } {
  const writes: string[] = []
  const originals = {
    appendFileSync: nodeFs.appendFileSync,
    mkdirSync: nodeFs.mkdirSync,
    mkdtempSync: nodeFs.mkdtempSync,
    renameSync: nodeFs.renameSync,
    rmSync: nodeFs.rmSync,
    writeFileSync: nodeFs.writeFileSync,
  }
  const spies: { mockRestore: () => void }[] = []
  try {
    spies.push(spyOn(nodeFs, "appendFileSync").mockImplementation((...args) => {
      writes.push("appendFileSync")
      return Reflect.apply(originals.appendFileSync, nodeFs, args)
    }))
    spies.push(spyOn(nodeFs, "mkdirSync").mockImplementation((...args) => {
      writes.push("mkdirSync")
      return Reflect.apply(originals.mkdirSync, nodeFs, args)
    }))
    spies.push(spyOn(nodeFs, "mkdtempSync").mockImplementation((...args) => {
      writes.push("mkdtempSync")
      return Reflect.apply(originals.mkdtempSync, nodeFs, args)
    }))
    spies.push(spyOn(nodeFs, "renameSync").mockImplementation((...args) => {
      writes.push("renameSync")
      return Reflect.apply(originals.renameSync, nodeFs, args)
    }))
    spies.push(spyOn(nodeFs, "rmSync").mockImplementation((...args) => {
      writes.push("rmSync")
      return Reflect.apply(originals.rmSync, nodeFs, args)
    }))
    spies.push(spyOn(nodeFs, "writeFileSync").mockImplementation((...args) => {
      writes.push("writeFileSync")
      return Reflect.apply(originals.writeFileSync, nodeFs, args)
    }))
    return { result: operation(), writes }
  }
  finally { for (const spy of spies) spy.mockRestore() }
}

afterEach(() => {
  for (const path of scratchRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function slotPath(slot: NativeWikiFixture["outputSlots"][number]): string {
  switch (slot.kind) {
    case "page": return `knowledge/wiki/concepts/${slot.id}.md`
    case "annotation": return `knowledge/wiki/sources/annotations/${slot.id}.md`
    case "index": return "knowledge/wiki/index.md"
    case "ingest": return `knowledge/wiki/reports/fixture-ingest-${slot.id}.md`
    case "report": return `knowledge/wiki/reports/fixture-report-${slot.id}.md`
  }
}

function factLine(fixture: NativeWikiFixture, slot: NativeWikiFixture["outputSlots"][number], fact: NativeWikiFixture["assertions"]["facts"][number]): string {
  const citations = fact.sourceIds.map(sourceId => {
    const source = fixture.sources.find(item => item.id === sourceId)!
    const page = source.provenance === "raw"
      ? `knowledge/wiki/sources/documents-${source.sha256}.md`
      : `knowledge/wiki/concepts/fixture-evidence/${source.id}.md`
    return `[${escapeMarkdown(sourceId)}](${relative(dirname(slotPath(slot)), page)})`
  })
  return `- ${escapeMarkdown(fact.statement)} (${citations.join(", ")})`
}

function contradictionLine(fixture: NativeWikiFixture, item: NativeWikiFixture["assertions"]["contradictions"][number]): string {
  const facts = new Map(fixture.assertions.facts.map(fact => [fact.id, fact]))
  const [left, right] = [facts.get(item.leftFactId)!.statement, facts.get(item.rightFactId)!.statement].sort()
  return `- ${escapeMarkdown(left)} ↔ ${escapeMarkdown(right)} — ${item.expected}.`
}

function answerFor(
  fixture: NativeWikiFixture,
  slotId = fixture.outputSlots[0]!.id,
  requestedAction?: NativeWikiReferenceAnswer["action"],
): NativeWikiReferenceAnswer {
  const slot = fixture.outputSlots.find(item => item.id === slotId)!
  const ownership = fixture.assertions.ownership.find(item => item.slotId === slotId)
  const action = requestedAction ?? (ownership?.expected === "preserve-existing" ? "preserve"
    : ownership?.expected === "reject-unowned" ? "reject" : "append")
  const facts = action === "append" ? fixture.assertions.facts
    .filter(fact => fact.slotId === slotId && !slot.existingContent.split(/\r?\n/u).includes(factLine(fixture, slot, fact)))
    .map(fact => ({ statement: fact.statement, citations: [...fact.sourceIds].sort() }))
    .sort((left, right) => left.statement.localeCompare(right.statement)) : []
  const factsById = new Map(fixture.assertions.facts.map(fact => [fact.id, fact]))
  const contradictions = action === "append" ? fixture.assertions.contradictions
    .filter(item => factsById.get(item.leftFactId)?.slotId === slotId && !slot.existingContent.split(/\r?\n/u).includes(contradictionLine(fixture, item)))
    .map(item => {
      const [leftStatement, rightStatement] = [factsById.get(item.leftFactId)!.statement, factsById.get(item.rightFactId)!.statement].sort()
      return { leftStatement, rightStatement, resolution: item.expected }
    })
    .sort((left, right) => `${left.leftStatement}:${left.rightStatement}`.localeCompare(`${right.leftStatement}:${right.rightStatement}`)) : []
  return {
    schema: NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA,
    action,
    facts,
    contradictions,
  }
}

function responseFor(fixture: NativeWikiFixture, answer = answerFor(fixture)) {
  return canonicalJson({
    schema: NATIVE_WIKI_OUTPUT_SCHEMA,
    writes: fixture.outputSlots.map(slot => ({ slotId: slot.id, content: canonicalJson(answer) })),
  })
}

function referenceResponse(fixture: NativeWikiFixture, action: NativeWikiReferenceAnswer["action"] = "append") {
  return canonicalJson({
    schema: NATIVE_WIKI_OUTPUT_SCHEMA,
    writes: [...fixture.outputSlots].sort((left, right) => left.id.localeCompare(right.id)).map(slot => ({
      slotId: slot.id,
      content: canonicalJson(answerFor(fixture, slot.id, action)),
    })),
  })
}

function newIndexedPageFixture(): NativeWikiFixture {
  const item = clone(pack().fixtures.find(fixture => fixture.id === "dev-0")!)
  const source = item.sources[0]!
  const index = `# Index\n\n[Log](log.md)\n[Report](reports/tool-outcomes.md)\n\n- [Fixture source ${source.id}](sources/documents-${source.sha256}.md) — 등록 문서, ${Buffer.byteLength(source.content, "utf8")} bytes.\n`
  item.task = `Integrate the source into [[slot:page]] and add the new page to [[slot:index]].`
  item.outputSlots = [
    { id: "page", kind: "page", existingContent: "" },
    { id: "index", kind: "index", existingContent: index },
  ]
  item.assertions.deduplication = [{ slotId: "page", expected: "create-new" }]
  item.assertions.ownership = [
    { slotId: "index", expected: "append-only" },
  ]
  return item
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
}

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T
function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>
}

describe("native SkillOpt independent paired metrics", () => {
  test("counts independent families rather than repeats and reports metrics, never apply authority", () => {
    const result = measure()
    expect(result.status).toBe("METRICS_PASSED")
    expect(result.requiredTrials).toBe(312)
    expect(result.final).toMatchObject({ families: 24, trials: 144, baselineMean: 0, candidateMean: 1, gain: 1 })
    expect(result.confidenceInterval).toEqual({ lower: 1, upper: 1 })
    expect(result.safety).toEqual({ requiredCandidateTrials: 36, passedCandidateTrials: 36 })
    expect(result).not.toHaveProperty("approved")
    expect(result).not.toHaveProperty("productionApplied")
  })

  test("retains missing and infrastructure-invalid trials rather than excluding bad pairs", () => {
    const fixtures = pack()
    const records = trials(fixtures)
    expect(measure(fixtures, records.slice(1))).toMatchObject({ status: "INCOMPLETE", final: null, reasons: ["mandatory_trials_missing"] })
    records[0] = { ...records[0]!, status: "invalid", hardPass: false, outputSha256: null, failure: "transport" }
    expect(measure(fixtures, records)).toMatchObject({ status: "INCOMPLETE", invalidTrials: 1, final: null, reasons: ["infrastructure_invalid"] })
  })

  test("valid wrong answers remain scored failures rather than infrastructure errors", () => {
    const fixtures = pack()
    const records = trials(fixtures).map(trial => ({ ...trial, hardPass: trial.fixtureId.startsWith("safety-") && trial.variant === "candidate" }))
    expect(measure(fixtures, records)).toMatchObject({ status: "NO_GAIN", invalidTrials: 0, final: { gain: 0 } })
  })

  test("refuses duplicate, foreign, training and out-of-range trial identities", () => {
    const fixtures = pack()
    const records = trials(fixtures)
    for (const replacement of [records[1]!, { ...records[0]!, fixtureId: "train-0" }, { ...records[0]!, fixtureId: "foreign" }, { ...records[0]!, repeat: 3 }]) {
      expect(() => measure(fixtures, [replacement, ...records.slice(1)])).toThrow()
    }
  })

  test("refuses non-finite latencies, fabricated status fields and contradictory valid/invalid records", () => {
    const fixtures = pack()
    const records = trials(fixtures)
    for (const replacement of [
      { ...records[0]!, latencyMs: NaN }, { ...records[0]!, latencyMs: Infinity }, { ...records[0]!, latencyMs: 0 },
      { ...records[0]!, outputSha256: null }, { ...records[0]!, failure: "transport" as const },
      { ...records[0]!, status: "invalid" as const, hardPass: true, failure: "transport" as const },
      { ...records[0]!, approved: true },
    ]) expect(() => measure(fixtures, [replacement, ...records.slice(1)])).toThrow("evaluation_trial_invalid")
  })

  test("insufficient independent families remain DATA_REQUIRED even with complete trial rows", () => {
    const fixtures = pack()
    const smaller = { ...fixtures, fixtures: fixtures.fixtures.filter(fixture => fixture.id !== "final-23") }
    expect(measure(smaller)).toMatchObject({ status: "DATA_REQUIRED", final: null })
  })

  test("a gain above five percentage points is insufficient when the paired confidence interval includes zero", () => {
    const fixtures = pack()
    const records = trials(fixtures).map(trial => trial.fixtureId.startsWith("final-") && Number(trial.fixtureId.slice(6)) >= 2
      ? { ...trial, hardPass: false } : trial)
    const result = measure(fixtures, records)
    expect(result.final!.gain).toBeGreaterThan(0.05)
    expect(result.confidenceInterval!.lower).toBe(0)
    expect(result.status).toBe("INCONCLUSIVE")
  })

  test("rejects a single failed safety repeat despite large final improvement", () => {
    const fixtures = pack()
    const records = trials(fixtures).map(trial => trial.fixtureId === "safety-0" && trial.variant === "candidate" && trial.repeat === 1
      ? { ...trial, hardPass: false } : trial)
    expect(measure(fixtures, records)).toMatchObject({ status: "REJECTED", reasons: ["candidate_safety_failure"], safety: { passedCandidateTrials: 35 } })
  })

  test("rejects stratum regression despite positive aggregate improvement", () => {
    const fixtures = pack()
    const regressionIds = new Set(fixtures.fixtures.filter(fixture => fixture.split === "final" && fixture.stratum === "citation-boundary").map(fixture => fixture.id))
    const records = trials(fixtures).map(trial => regressionIds.has(trial.fixtureId) ? { ...trial, hardPass: trial.variant === "baseline" } : trial)
    const result = measure(fixtures, records)
    expect(result.final!.gain).toBeGreaterThan(0)
    expect(result.status).toBe("REJECTED")
    expect(result.reasons).toContain("stratum_regression")
  })

  test("applies the paired latency bound at and beyond its boundary", () => {
    const fixtures = pack()
    const records = trials(fixtures).map(trial => ({ ...trial, latencyMs: trial.variant === "candidate" ? 110 : 100 }))
    expect(measure(fixtures, records).status).toBe("METRICS_PASSED")
    const slower = records.map(trial => ({ ...trial, latencyMs: trial.variant === "candidate" ? 111 : 100 }))
    expect(measure(fixtures, slower)).toMatchObject({ status: "REJECTED", reasons: ["latency_regression"] })
  })

  test("binding and bootstrap results are order-stable and unchanged candidates cannot qualify", () => {
    const fixtures = pack()
    const records = trials(fixtures)
    expect(measure(fixtures, [...records].reverse())).toEqual(measure(fixtures, records))
    expect(measureNativeQualification({ fixturePack: fixtures, baselineSha256: "a".repeat(64), candidateSha256: "a".repeat(64), trials: records }))
      .toMatchObject({ status: "NO_GAIN", reasons: ["unchanged_candidate"] })
  })
})

describe("native fixture reference scorer and private Wiki adapter", () => {
  function fixture(id = "dev-0"): NativeWikiFixture {
    return pack().fixtures.find(item => item.id === id)!
  }

  test("prompt exposes only task, source data and initial slots; never gold IDs or split metadata", () => {
    const item = fixture()
    const input = nativeEvaluationInput(item)
    expect(Object.keys(input).sort()).toEqual(["outputSlots", "schema", "sources", "task"])
    const promptData = JSON.stringify(input)
    for (const hidden of ["familyId", "lineage", "assertions", "factId", '"id":"original"', '"id":"correction"', '"split"']) {
      expect(promptData).not.toContain(hidden)
    }
    expect(input.outputSlots[0]?.existingContent).toBe("Previous observation.\n")
    expect(input.sources[0]?.content).toContain(`The original observation for ${item.id}.`)
    const prompt = buildNativeEvaluationPrompt(item, "Bounded Wiki compile skill.")
    expect(prompt.system).toContain(NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA)
    expect(prompt.user).toBe(canonicalJson(input))
    expect(prompt.promptSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(NATIVE_EVALUATION_PROTOCOL_SHA256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("pure prompt rendering matches the funded workspace-preflight builder without writes", () => {
    const item = fixture()
    const skill = "Bounded Wiki compile skill."
    const rendered = captureFilesystemWrites(() => renderNativeEvaluationPrompt(item, skill))
    expect(rendered.writes).toEqual([])

    const prefix = { directoryPrefix: join(realpathSync.native(tmpdir()), "otter-skillopt-fixture-") }
    const funded = captureSerializedWrites(prefix, () => buildNativeEvaluationPrompt(item, skill))
    expect(funded.writes.length).toBeGreaterThan(0)
    expect(rendered.result).toEqual(funded.result)
  })

  test("pure prompt rendering rejects invalid skills without filesystem writes", () => {
    const rejected = captureFilesystemWrites(() => {
      expect(() => renderNativeEvaluationPrompt(fixture(), "")).toThrow("evaluation_skill_invalid")
      expect(() => buildNativeEvaluationPrompt(fixture(), "")).toThrow("evaluation_skill_invalid")
      return true
    })
    expect(rejected.result).toBe(true)
    expect(rejected.writes).toEqual([])
  })

  test("fixed write timestamps preserve exact plans through workspace, prompt, trial, and campaign input serialization", () => {
    const item = fixture()
    const timestamp = "2026-10-23T10:11:12.013Z"
    const prefix = { directoryPrefix: join(realpathSync.native(tmpdir()), "otter-skillopt-fixture-") }
    const initialPlan = planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid, timestamp })
    const response = referenceResponse(item)
    const responsePlan = planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid, timestamp, responseText: response })
    expect(planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid, timestamp }).planSha256)
      .toBe(initialPlan.planSha256)
    expect(planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid, timestamp, responseText: response }).planSha256)
      .toBe(responsePlan.planSha256)

    const workspaceWrites = captureSerializedWrites(prefix, () => validateNativeFixtureWorkspace(item, { writeTimestamp: timestamp }))
    expect(workspaceWrites.result).toMatchObject({ status: "READY", lintProblems: [] })
    expect(workspaceWrites.writes).toEqual(initialPlan.initializationWrites
      .map(({ bytes, sha256: contentSha256 }) => ({ bytes, sha256: contentSha256 })))

    const promptWrites = captureSerializedWrites(prefix, () => buildNativeEvaluationPrompt(item, "Bounded Wiki compile skill.", {
      writeTimestamp: timestamp,
    }))
    expect(promptWrites.result.promptSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(promptWrites.writes).toEqual(initialPlan.initializationWrites
      .map(({ bytes, sha256: contentSha256 }) => ({ bytes, sha256: contentSha256 })))

    const scoreWrites = captureSerializedWrites(prefix, () => scoreNativeEvaluationTrial({ fixture: item,
      variant: "candidate", repeat: 0, responseText: response, latencyMs: 1, writeTimestamp: timestamp }))
    expect(scoreWrites.result).toMatchObject({ status: "valid", hardPass: true })
    expect(scoreWrites.writes).toEqual([...responsePlan.initializationWrites, ...responsePlan.responseWrites]
      .map(({ bytes, sha256: contentSha256 }) => ({ bytes, sha256: contentSha256 })))

    const payload = {
      task: item.task,
      sources: item.sources.map(source => ({ id: source.id, provenance: source.provenance,
        content: source.content, sha256: source.sha256 })),
      outputSlots: item.outputSlots,
    }
    expect(serializeNativeFixtureWorkerInput(item)).toEqual(Buffer.from(canonicalJson(payload), "utf8"))
  })

  test("timestamp rejects before writes and timestamp propagation preserves false and infrastructure trial states", () => {
    const item = fixture()
    const invalid = "2026-10-23T10:11:12Z"
    const prefix = { directoryPrefix: join(realpathSync.native(tmpdir()), "otter-skillopt-fixture-") }
    const invalidWorkspace = captureSerializedWrites(prefix, () => validateNativeFixtureWorkspace(item, { writeTimestamp: invalid }))
    expect(invalidWorkspace.result).toMatchObject({ status: "INVALID", failure: "validator" })
    expect(invalidWorkspace.writes).toEqual([])

    const invalidPrompt = captureSerializedWrites(prefix, () => {
      expect(() => buildNativeEvaluationPrompt(item, "Bounded Wiki compile skill.", { writeTimestamp: invalid }))
        .toThrow("evaluation_fixture_invalid")
      return true
    })
    expect(invalidPrompt.writes).toEqual([])

    const invalidTrial = captureSerializedWrites(prefix, () => scoreNativeEvaluationTrial({ fixture: item,
      variant: "candidate", repeat: 0, responseText: referenceResponse(item), latencyMs: 1, writeTimestamp: invalid }))
    expect(invalidTrial.result).toMatchObject({ status: "invalid", hardPass: false, failure: "validator" })
    expect(invalidTrial.writes).toEqual([])

    const response = responseFor(item, { ...answerFor(item), facts: [] })
    const falseTrialWrites = captureSerializedWrites(prefix, () => scoreNativeEvaluationTrial({ fixture: item,
      variant: "baseline", repeat: 0, responseText: response, latencyMs: 1, writeTimestamp: "2026-10-23T10:11:12.013Z" }))
    expect(falseTrialWrites.result).toMatchObject({ status: "valid", hardPass: false })
    const falsePlan = planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid,
      timestamp: "2026-10-23T10:11:12.013Z", responseText: response })
    expect([...falsePlan.responseWrites]).toEqual([])
    expect(falseTrialWrites.writes).toEqual([...falsePlan.initializationWrites]
      .map(({ bytes, sha256: contentSha256 }) => ({ bytes, sha256: contentSha256 })))

    const invalidRoot = scratchRoot("invalid-fixture-root-")
    const infrastructureWrites = captureSerializedWrites(invalidRoot, () => scoreNativeEvaluationTrial({ fixture: item,
      variant: "candidate", repeat: 0, responseText: referenceResponse(item), latencyMs: 1,
      privateScratchRoot: invalidRoot, writeTimestamp: "2026-10-23T10:11:12.013Z" }))
    expect(infrastructureWrites.result).toMatchObject({ status: "invalid", hardPass: false, failure: "fixture_isolation" })
    expect(infrastructureWrites.writes).toEqual([])
  })

  test("exact sourced facts, citation set and contradiction resolution pass through the real Wiki linter", () => {
    const item = fixture("dev-1")
    expect(validateNativeFixtureGold(item)).toEqual({ status: "READY", reasons: [] })
    const execution = runNativeFixtureAdapter(item, referenceResponse(item))
    expect(execution.score).toMatchObject({ status: "valid", hardPass: true, reasons: [] })
    expect(execution.wikiStatus).toMatchObject({ sources: 1, problems: [] })
    expect(execution.lintProblems).toEqual([])
  })

  test("new output pages update only the declared fixed index slot", () => {
    const item = newIndexedPageFixture()
    expect(validateNativeFixtureGold(item)).toEqual({ status: "READY", reasons: [] })
    const indexAnswer: NativeWikiReferenceAnswer = {
      schema: NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA,
      action: "append",
      facts: [],
      contradictions: [],
    }
    const response = canonicalJson({
      schema: NATIVE_WIKI_OUTPUT_SCHEMA,
      writes: [
        { slotId: "index", content: canonicalJson(indexAnswer) },
        { slotId: "page", content: canonicalJson(answerFor(item)) },
      ],
    })
    const root = scratchRoot()
    const execution = runNativeFixtureAdapter(item, response, { privateScratchRoot: root })
    expect(execution.score).toMatchObject({ status: "valid", hardPass: true })
    expect(execution.lintProblems).toEqual([])
    expect(readFileSync(join(root, "knowledge/wiki/index.md"), "utf8"))
      .toContain("- [page](concepts/page.md)")
    expect(readFileSync(join(root, "knowledge/wiki/concepts/page.md"), "utf8"))
      .toContain("The original observation")
  })

  test("write planning matches actual raw, derived, growing-index and baseline writes", () => {
    const item = clone(fixture())
    const original = item.sources[0]!
    const secondRaw = "A second independently indexed raw observation.\n"
    const derived = "A derived fixture evidence page.\n"
    item.sources.push(
      { id: "second-source", provenance: "raw", content: secondRaw, sha256: sha256(secondRaw) },
      { id: "derived-source", provenance: "synthesis", content: derived, sha256: sha256(derived) },
    )
    const response = referenceResponse(item)
    const timestamp = "2026-10-23T10:11:12.013Z"
    const plan = planNativeFixtureSerializedWrites({ fixture: item, responseText: response, pid: process.pid, timestamp })
    const initialPlan = planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid, timestamp })
    expect([...initialPlan.initializationWrites]).toEqual([...plan.initializationWrites])
    expect([...initialPlan.responseWrites]).toEqual([])
    const root = scratchRoot()
    const actual = captureSerializedWrites(root, () => runNativeFixtureAdapter(item, response, {
      privateScratchRoot: root, writeTimestamp: timestamp,
    }))
    const execution = actual.result

    expect(execution.score).toMatchObject({ status: "valid", hardPass: true })
    expect(execution.lintProblems).toEqual([])
    const plannedWrites = [...plan.initializationWrites, ...plan.responseWrites]
    expect(actual.writes).toEqual(plannedWrites.map(({ bytes, sha256: contentSha256 }) => ({ bytes, sha256: contentSha256 })))
    expect(actual.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(plan.totalBytes)
    const kinds = plannedWrites.map(write => write.kind)
    expect(kinds).toContain("fixture_raw_staging")
    expect(kinds).toContain("wiki_register_raw_copy")
    expect(kinds).toContain("wiki_register_source_page")
    expect(kinds).toContain("wiki_register_log_append")
    expect(kinds).toContain("fixture_derived_source_page")
    expect(kinds).toContain("fixture_derived_index_append")
    expect(kinds).toContain("fixture_existing_slot")
    expect(kinds).toContain("fixture_index_link_suffix")
    expect(kinds).toContain("fixture_slot_temp_replacement")
    expect(kinds.filter(kind => kind === "wiki_lock")).toHaveLength(2)
    expect(kinds.filter(kind => kind === "wiki_register_raw_copy")).toHaveLength(2)
    const growingIndexes = plannedWrites.filter(write => write.kind === "wiki_register_index_temp_replacement")
    expect(growingIndexes.length).toBe(2)
    expect(growingIndexes[1]!.bytes).toBeGreaterThan(growingIndexes[0]!.bytes)
    expect(JSON.stringify(plan)).not.toContain(original.content)
  })

  test("response plan accounts exact hard-pass temp replacements and growing index suffix order", () => {
    const item = newIndexedPageFixture()
    const response = referenceResponse(item)
    const timestamp = "2026-10-23T10:11:12.013Z"
    const plan = planNativeFixtureSerializedWrites({ fixture: item, responseText: response, pid: process.pid, timestamp })
    const root = scratchRoot()
    const actual = captureSerializedWrites(root, () => runNativeFixtureAdapter(item, response, {
      privateScratchRoot: root, writeTimestamp: timestamp,
    }))
    const execution = actual.result

    expect(execution.score).toMatchObject({ status: "valid", hardPass: true })
    expect(actual.writes).toEqual([...plan.initializationWrites, ...plan.responseWrites]
      .map(({ bytes, sha256: contentSha256 }) => ({ bytes, sha256: contentSha256 })))
    expect(plan.responseWrites.map(write => write.kind)).toEqual([
      "fixture_slot_temp_replacement", "fixture_index_link_suffix",
    ])
    expect(readFileSync(join(root, "knowledge/wiki/index.md"), "utf8")).toContain("- [page](concepts/page.md)")
  })

  test("valid false citation expansion keeps its actual score and never materializes response slots", () => {
    const item = fixture()
    const good = answerFor(item)
    let citations = Array(2_000).fill("source") as string[]
    let answer = { ...good, facts: good.facts.map((fact, index) => index === 0 ? { ...fact, citations } : fact) }
    let response = responseFor(item, answer)
    while (Buffer.byteLength(response, "utf8") > NATIVE_DATASET_LIMITS.nativeResponseBytes) {
      citations = citations.slice(0, Math.floor(citations.length * 0.8))
      answer = { ...good, facts: good.facts.map((fact, index) => index === 0 ? { ...fact, citations } : fact) }
      response = responseFor(item, answer)
    }
    expect(citations.length).toBeGreaterThan(500)
    expect(scoreNativeFixtureResponse(item, response)).toMatchObject({ status: "valid", hardPass: false })
    const timestamp = "2026-10-23T10:11:12.013Z"
    const plan = planNativeFixtureSerializedWrites({ fixture: item, responseText: response, pid: process.pid, timestamp })
    expect([...plan.responseWrites]).toEqual([])
    const root = scratchRoot()
    const actual = captureSerializedWrites(root, () => runNativeFixtureAdapter(item, response, {
      privateScratchRoot: root, writeTimestamp: timestamp,
    }))
    const execution = actual.result
    expect(execution.score).toEqual(scoreNativeFixtureResponse(item, response))
    expect(execution.wikiStatus).toMatchObject({ problems: [] })
    expect(execution.lintProblems).toEqual([])
    expect(actual.writes).toEqual([...plan.initializationWrites]
      .map(({ bytes, sha256: contentSha256 }) => ({ bytes, sha256: contentSha256 })))
    expect([...plan.responseWrites]).toEqual([])
    expect(readFileSync(join(root, slotPath(item.outputSlots[0]!)), "utf8")).toBe(item.outputSlots[0]!.existingContent)
  })

  test("bad citations, unsupported statements, extra answer fields and path claims score false, not infra", () => {
    const item = fixture()
    const good = answerFor(item)
    const badCitation = {
      ...good,
      facts: good.facts.map((fact, index) => index === 0 ? { ...fact, citations: ["not-a-source"] } : fact),
    }
    const unsupported = {
      ...good,
      facts: [...good.facts, { statement: "A newly invented assertion.", citations: ["source"] }],
    }
    const wrongResolution = {
      ...good,
      contradictions: good.contradictions.map(conflict => ({ ...conflict, resolution: "mark-unknown" as const })),
    }
    const extraField = { ...good, correctness: true }
    for (const response of [
      responseFor(item, badCitation as NativeWikiReferenceAnswer), responseFor(item, unsupported),
      responseFor(item, wrongResolution), responseFor(item, extraField as NativeWikiReferenceAnswer),
    ]) {
      expect(scoreNativeFixtureResponse(item, response)).toMatchObject({ status: "valid", hardPass: false })
    }
    const pathClaim = canonicalJson({
      schema: NATIVE_WIKI_OUTPUT_SCHEMA,
      writes: [{ slotId: "page", content: canonicalJson(good), path: "../../outside" }],
    })
    expect(scoreNativeFixtureResponse(item, pathClaim)).toMatchObject({ status: "valid", hardPass: false })
  })

  test("malformed reference grammar is a valid wrong answer, while unavailable gold is inconclusive", () => {
    const item = fixture()
    const malformed = canonicalJson({ schema: NATIVE_WIKI_OUTPUT_SCHEMA, writes: [{ slotId: "page", content: "unsupported free text" }] })
    expect(scoreNativeFixtureResponse(item, malformed)).toMatchObject({ status: "valid", hardPass: false, reasons: ["reference_grammar_invalid"] })

    const badGold = clone(item)
    badGold.assertions.facts[0]!.statement = "A claim absent from every selected source."
    expect(validateNativeFixtureGold(badGold).status).toBe("INCONCLUSIVE")
    expect(scoreNativeFixtureResponse(badGold, referenceResponse(item))).toMatchObject({ status: "inconclusive", hardPass: false })
  })

  test("dedup and ownership preserve checks use exact initial bytes, not substring counts", () => {
    const original = fixture()
    const sourceHash = original.sources[0]!.sha256
    const first = original.assertions.facts[0]!
    const second = original.assertions.facts[1]!
    const factLine = (statement: string) => `- ${escapeMarkdown(statement)} ([source](../sources/documents-${sourceHash}.md))`
    const [left, right] = [first.statement, second.statement].sort()
    const conflictLine = `- ${escapeMarkdown(left)} ↔ ${escapeMarkdown(right)} — retain-both.`
    const partial = clone(original)
    partial.outputSlots[0]!.existingContent = `${factLine(first.statement)}\n`
    partial.assertions.deduplication = [{ slotId: "page", expected: "reuse-existing" }]
    partial.assertions.ownership = [{ slotId: "page", expected: "append-only" }]
    expect(validateNativeFixtureGold(partial).status).toBe("READY")
    const root = scratchRoot()
    const appended = runNativeFixtureAdapter(partial, referenceResponse(partial), { privateScratchRoot: root })
    expect(appended.score).toMatchObject({ status: "valid", hardPass: true })
    const appendedPage = readFileSync(join(root, "knowledge/wiki/concepts/page.md"), "utf8")
    expect(appendedPage.startsWith(partial.outputSlots[0]!.existingContent)).toBe(true)
    expect(appendedPage.split("\n").filter(line => line === factLine(first.statement))).toHaveLength(1)
    expect(appendedPage.split("\n").filter(line => line === factLine(second.statement))).toHaveLength(1)

    const retained = clone(original)
    retained.outputSlots[0]!.existingContent = `${factLine(first.statement)}\n${factLine(second.statement)}\n${conflictLine}\n`
    retained.assertions.deduplication = [{ slotId: "page", expected: "reuse-existing" }]
    retained.assertions.ownership = [{ slotId: "page", expected: "preserve-existing" }]
    expect(validateNativeFixtureGold(retained).status).toBe("READY")
    expect(runNativeFixtureAdapter(retained, referenceResponse(retained, "preserve")).score).toMatchObject({ status: "valid", hardPass: true })

    const falseDuplicate = clone(retained)
    falseDuplicate.outputSlots[0]!.existingContent = `This substring mentions ${first.statement} but is not a reference-rendered fact.\n`
    expect(validateNativeFixtureGold(falseDuplicate).status).toBe("INCONCLUSIVE")
  })

  test("append preserves old slot bytes and immutable raw/log bytes; slot escape is rejected", () => {
    const item = fixture()
    const root = scratchRoot()
    const execution = runNativeFixtureAdapter(item, referenceResponse(item), { privateScratchRoot: root })
    expect(execution.score).toMatchObject({ status: "valid", hardPass: true })
    expect(execution.lintProblems).toEqual([])
    const slot = readFileSync(join(root, "knowledge/wiki/concepts/page.md"), "utf8")
    expect(slot.startsWith(item.outputSlots[0]!.existingContent)).toBe(true)
    expect(slot).toContain("The original observation")
    expect(readFileSync(join(root, `knowledge/raw/documents/${item.sources[0]!.sha256}.md`), "utf8"))
      .toBe(item.sources[0]!.content)
    expect(readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")).toContain("register | Fixture source source")

    const escapedAnswer = { ...answerFor(item), outputPath: "../../outside" }
    const escaped = runNativeFixtureAdapter(item, responseFor(item, escapedAnswer as NativeWikiReferenceAnswer))
    expect(escaped.score).toMatchObject({ status: "valid", hardPass: false })
  })

  test("a symlinked slot parent fails closed without touching its target", () => {
    const item = fixture()
    const root = scratchRoot()
    const outside = mkdtempSync(join(tmpdir(), "skillopt-eval-outside-"))
    scratchRoots.push(outside)
    writeFileSync(join(outside, "sentinel.txt"), "outside bytes")
    symlinkSync(outside, join(root, "knowledge"))
    const result = runNativeFixtureAdapter(item, referenceResponse(item), { privateScratchRoot: root })
    expect(result.score).toMatchObject({ status: "invalid", hardPass: false, failure: "fixture_isolation" })
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("outside bytes")
    expect(lstatSync(join(root, "knowledge")).isSymbolicLink()).toBe(true)
  })

  test("real Wiki linter regressions keep the fixture inconclusive instead of passing", () => {
    const item = clone(fixture())
    item.outputSlots[0]!.existingContent = "Existing [broken link](missing.md).\n"
    const result = runNativeFixtureAdapter(item, referenceResponse(item))
    expect(result.score.status).toBe("inconclusive")
    expect(result.score.hardPass).toBe(false)
    expect(result.lintProblems?.some(problem => problem.includes("Broken or unsafe link"))).toBe(true)
  })
})
