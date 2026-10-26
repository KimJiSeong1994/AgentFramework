import {
  NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT, NATIVE_WIKI_SPLIT_MINIMUMS,
  NATIVE_WIKI_OUTPUT_SCHEMA, NATIVE_WIKI_STRATA, validateNativeFixturePack,
  type NativeWikiFixture, type NativeWikiFixturePack, type NativeWikiSplit,
} from "../src/skillopt/dataset.ts"
import { NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA } from "../src/skillopt/evaluation.ts"
import { canonicalJson, sha256 } from "../src/skillopt/pilot.ts"

/** Synthetic test data only; this helper creates neither reviewed approval nor any native execution proof. */
export function makeSkillOptCanaryFixture(): Readonly<{
  pack: NativeWikiFixturePack
  fixture: NativeWikiFixture
  packSha256: string
  fixtureSha256: string
}> {
  const fixtures: NativeWikiFixture[] = []
  for (const [split, count] of Object.entries(NATIVE_WIKI_SPLIT_MINIMUMS) as [NativeWikiSplit, number][]) {
    for (let index = 0; index < count; index += 1) {
      const id = `${split}-${index}`
      const sourceId = "source"
      const slotId = "page"
      const stratum = NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!
      const firstObservation = stratum === "correction-conflict"
        ? `The recorded count for ${id} is 5.`
        : `The first observation for ${id} was recorded.`
      const secondObservation = stratum === "correction-conflict"
        ? `The corrected recorded count for ${id} is 7.`
        : `The second observation for ${id} was recorded.`
      const sourceContent = `${firstObservation}\n${secondObservation}\n`
      const sourceSha256 = sha256(sourceContent)
      const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
      const line = (statement: string) => `- ${escape(statement)} ([${sourceId}](../sources/documents-${sourceSha256}.md))`
      const existingPage = stratum === "dedup-resume"
        ? `# ${slotId}\n\n${line(firstObservation)}\n`
        : stratum === "ownership-injection"
          ? `# ${slotId}\n\n${line(firstObservation)}\n${line(secondObservation)}\n`
          : stratum === "correction-conflict"
            ? `# ${slotId}\n\nPreviously established page content.\n`
            : ""
      const sourceIndex = `# Index\n\n[Log](log.md)\n[Report](reports/tool-outcomes.md)\n\n- [Fixture source ${sourceId}](sources/documents-${sourceSha256}.md) — 등록 문서, ${Buffer.byteLength(sourceContent, "utf8")} bytes.\n`
      const assertions: NativeWikiFixture["assertions"] = {
        facts: [
          { id: `fact-${id}-first`, slotId, statement: firstObservation, sourceIds: [sourceId] },
          { id: `fact-${id}-second`, slotId, statement: secondObservation, sourceIds: [sourceId] },
        ],
        citations: [
          { factId: `fact-${id}-first`, sourceId },
          { factId: `fact-${id}-second`, sourceId },
        ],
        contradictions: stratum === "correction-conflict"
          ? [{ leftFactId: `fact-${id}-first`, rightFactId: `fact-${id}-second`, expected: "prefer-correction" }]
          : [],
        deduplication: stratum === "citation-boundary"
          ? [{ slotId, expected: "create-new" }]
          : stratum === "dedup-resume"
            ? [{ slotId, expected: "reuse-existing" }]
            : [],
        ownership: [
          ...(stratum === "ownership-injection" ? [{ slotId, expected: "preserve-existing" as const }] : []),
          ...(stratum === "correction-conflict" || stratum === "dedup-resume" ? [{ slotId, expected: "append-only" as const }] : []),
          { slotId: "index", expected: "append-only" },
        ],
      }
      fixtures.push({
        id,
        familyId: `family-${id}`,
        lineage: [`lineage-${id}`],
        split,
        stratum,
        authorship: "agent-authored",
        sources: [{ id: sourceId, provenance: "raw", content: sourceContent, sha256: sourceSha256 }],
        task: `Integrate the observations for ${id} in [[slot:${slotId}]] and maintain the index in [[slot:index]].`,
        outputSlots: [
          { id: slotId, kind: "page", existingContent: existingPage },
          { id: "index", kind: "index", existingContent: sourceIndex },
        ],
        assertions,
        forbiddenChanges: [...NATIVE_PROTECTED_CHANGES],
      })
    }
  }
  const rawPack: NativeWikiFixturePack = {
    schema: NATIVE_FIXTURE_PACK_SCHEMA,
    contract: NATIVE_WIKI_CONTRACT,
    fixtures,
  }
  // Exercise the actual strict parser and return its detached/frozen canonical snapshot.
  const validated = validateNativeFixturePack(rawPack)
  if (validated.status !== "STRUCTURALLY_VALID") throw new Error("Synthetic canary fixture pack did not validate")
  const fixture = validated.pack.fixtures.find(item => item.id === "dev-0")
  if (!fixture) throw new Error("Synthetic canary dev fixture is missing")
  return Object.freeze({
    pack: validated.pack,
    fixture,
    packSha256: validated.packSha256,
    fixtureSha256: sha256(canonicalJson(fixture)),
  })
}

/** Build a deterministic passing response for the synthetic dev fixture; the production scorer still decides pass/fail. */
export function successfulSkillOptCanaryResponse(fixture: NativeWikiFixture): string {
  const writes = fixture.outputSlots.map(slot => {
    const ownership = fixture.assertions.ownership.find(item => item.slotId === slot.id)
    const action = ownership?.expected === "preserve-existing" ? "preserve"
      : ownership?.expected === "reject-unowned" ? "reject" : "append"
    const facts = action === "append" ? fixture.assertions.facts
      .filter(item => item.slotId === slot.id)
      .map(item => ({ statement: item.statement, citations: [...item.sourceIds].sort() }))
      .sort((left, right) => left.statement.localeCompare(right.statement)) : []
    const factsById = new Map(fixture.assertions.facts.map(item => [item.id, item]))
    const contradictions = action === "append" ? fixture.assertions.contradictions
      .filter(item => factsById.get(item.leftFactId)?.slotId === slot.id)
      .map(item => {
        const [leftStatement, rightStatement] = [factsById.get(item.leftFactId)!.statement, factsById.get(item.rightFactId)!.statement].sort()
        return { leftStatement, rightStatement, resolution: item.expected }
      })
      .sort((left, right) => `${left.leftStatement}:${left.rightStatement}`.localeCompare(`${right.leftStatement}:${right.rightStatement}`)) : []
    return {
      slotId: slot.id,
      content: canonicalJson({ schema: NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA, action, facts, contradictions }),
    }
  }).sort((left, right) => left.slotId.localeCompare(right.slotId))
  return canonicalJson({ schema: NATIVE_WIKI_OUTPUT_SCHEMA, writes })
}
