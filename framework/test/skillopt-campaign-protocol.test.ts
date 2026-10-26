import { expect, test } from "bun:test"
import {
  NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT,
  NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS, NATIVE_WIKI_STRATA,
  type NativeWikiFixture, type NativeWikiFixturePack, type NativeWikiSplit,
} from "../src/skillopt/dataset.ts"
import {
  buildNativeAdapterManifest, buildNativeCampaignSchedule, createNativeTrainerWire,
  createNativeTrainerWireForSchedule, forecastNativeCampaign,
} from "../src/skillopt/campaign-protocol.ts"
import { assembleSkill, COMPILE_ANCHOR, NATIVE_SKILLOPT_LIMITS, sha256 } from "../src/skillopt/pilot.ts"

// Synthetic schema fixtures only: neither a human-approved corpus nor model-performance evidence.
function fixture(split: NativeWikiSplit, index: number): NativeWikiFixture {
  const id = `${split}-${index}`
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const stratum = NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!
  const facts = ["first", "second"].map(label => ({
    id: `fact-${id}-${label}`, slotId, statement: `${label} fixture statement for ${id}.`, sourceIds: [sourceId],
  }))
  const content = facts.map(fact => fact.statement).join("\n") + "\n"
  return {
    id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split, stratum, authorship: "agent-authored",
    sources: [{ id: sourceId, provenance: "raw", content, sha256: sha256(content) }],
    task: `Use the supplied evidence for [[slot:${slotId}]].`,
    outputSlots: [{ id: slotId, kind: "page", existingContent: stratum === "dedup-resume" || stratum === "ownership-injection" ? "Existing fixture bytes.\n" : "" }],
    assertions: {
      facts, citations: facts.map(fact => ({ factId: fact.id, sourceId })),
      contradictions: stratum === "correction-conflict" ? [{ leftFactId: facts[0]!.id, rightFactId: facts[1]!.id, expected: "mark-unknown" }] : [],
      deduplication: stratum === "dedup-resume" ? [{ slotId, expected: "reuse-existing" }] : [],
      ownership: stratum === "ownership-injection" ? [{ slotId, expected: "preserve-existing" }] : [],
    },
    forbiddenChanges: NATIVE_PROTECTED_CHANGES,
  }
}
function pack(): NativeWikiFixturePack {
  return {
    schema: NATIVE_FIXTURE_PACK_SCHEMA, contract: NATIVE_WIKI_CONTRACT,
    fixtures: NATIVE_WIKI_SPLITS.flatMap(split => Array.from({ length: NATIVE_WIKI_SPLIT_MINIMUMS[split] }, (_, index) => fixture(split, index))),
  }
}

test("pinned trainer selection overhead stays charged outside fresh paired qualification", () => {
  const schedule = buildNativeCampaignSchedule(pack())
  expect(schedule.training).toHaveLength(24)
  expect(schedule.trainerSelection).toHaveLength(48)
  expect(schedule.trainerSelectionRequests).toBe(96)
  expect(schedule.qualification).toHaveLength(312)
  expect(schedule.targetRequests).toBe(432)
  expect(schedule.targetRequests + schedule.canaryReserve).toBeLessThanOrEqual(NATIVE_SKILLOPT_LIMITS.targetRequests)
  expect(schedule.training.every(item => item.caseId.startsWith("train-") && item.replicate === 0)).toBe(true)
  expect(schedule.trainerSelection.every(item => item.caseId.startsWith("dev-"))).toBe(true)
  expect(new Set(schedule.trainerSelection.map(item => `${item.caseId}:${item.replicate}`)).size).toBe(48)
  expect(schedule.training.length + schedule.trainerSelectionRequests + schedule.qualification.filter(item => item.split === "dev").length).toBe(216)
})

test("every qualification pair is adjacent and AB/BA balanced without dropping repeats", () => {
  const schedule = buildNativeCampaignSchedule(pack())
  const seen = new Set<string>()
  for (const split of ["dev", "final", "safety"] as const) {
    const trials = schedule.qualification.filter(item => item.split === split)
    expect(trials).toHaveLength(NATIVE_WIKI_SPLIT_MINIMUMS[split] * 6)
    let baselineFirst = 0
    for (let index = 0; index < trials.length; index += 2) {
      const first = trials[index]!
      const second = trials[index + 1]!
      expect(second.fixtureId).toBe(first.fixtureId)
      expect(second.repeat).toBe(first.repeat)
      expect(second.variant).not.toBe(first.variant)
      if (first.variant === "baseline") baselineFirst++
      for (const trial of [first, second]) {
        const key = `${trial.fixtureId}:${trial.repeat}:${trial.variant}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
        expect(trial.repeat).toBeGreaterThanOrEqual(0)
        expect(trial.repeat).toBeLessThan(3)
      }
    }
    expect(baselineFirst).toBe(trials.length / 4)
  }
  expect(seen.size).toBe(312)
  const phases = schedule.qualification.map(item => item.split)
  expect(phases.lastIndexOf("dev")).toBeLessThan(phases.indexOf("final"))
  expect(phases.lastIndexOf("final")).toBeLessThan(phases.indexOf("safety"))
})

test("schedule is deterministic under input reordering and binds task changes", () => {
  const input = pack()
  const schedule = buildNativeCampaignSchedule(input)
  expect(buildNativeCampaignSchedule({ ...input, fixtures: [...input.fixtures].reverse() })).toEqual(schedule)
  const changed = { ...input, fixtures: input.fixtures.map((item, index) => index ? item : { ...item, task: `${item.task} Be concise.` }) }
  expect(buildNativeCampaignSchedule(changed).scheduleSha256).not.toBe(schedule.scheduleSha256)
  expect(Object.isFrozen(schedule.qualification[0])).toBe(true)
})

test("an incomplete or larger corpus is refused rather than silently subselected", () => {
  const input = pack()
  expect(() => buildNativeCampaignSchedule({ ...input, fixtures: input.fixtures.slice(1) })).toThrow("campaign_data_required")
  expect(() => buildNativeCampaignSchedule({ ...input, fixtures: [...input.fixtures, fixture("train", 24)] })).toThrow("campaign_fixture_count")
})

test("trainer manifest contains only exact train/dev cases and no sealed data", () => {
  const manifest = buildNativeAdapterManifest({ fixturePack: pack(), runId: "run_123", originalSkillSha256: "a".repeat(64), sourceLockSha256: "b".repeat(64) })
  expect(Object.keys(manifest).sort()).toEqual(["schema", "runId", "mode", "originalSkillSha256", "sourceLockSha256", "train", "selection"].sort())
  expect(manifest.train).toHaveLength(24)
  expect(manifest.selection).toHaveLength(48)
  const encoded = JSON.stringify(manifest)
  for (const forbidden of ["final-", "safety-", "assertions", "statement", "family-"]) expect(encoded).not.toContain(forbidden)
  expect(() => buildNativeAdapterManifest({ fixturePack: pack(), runId: "../run", originalSkillSha256: "a".repeat(64), sourceLockSha256: "b".repeat(64) })).toThrow("campaign_manifest_invalid")
})

test("forecast includes all 432 target calls and worst-case generator/review/canary reserves", () => {
  const input = pack()
  const fast = forecastNativeCampaign({ fixturePack: input, trainingMilliseconds: [1000, 2000], elapsedMilliseconds: 3500 })
  expect(fast.status).toBe("WITHIN_ESTIMATE")
  expect(fast.remainingEstimateMilliseconds).toBe(430 * 2000 + (40 + 2 + 16) * 120000)
  expect(fast.remainingActiveMilliseconds).toBe(NATIVE_SKILLOPT_LIMITS.activeMilliseconds - 3500)
  const slow = forecastNativeCampaign({ fixturePack: input, trainingMilliseconds: [40_000, 39_000], elapsedMilliseconds: 80_000 })
  expect(slow.status).toBe("BUDGET_FORECAST_REFUSED")
  expect(slow.targetRequests).toBe(fast.targetRequests)
  expect(slow.scheduleSha256).toBe(fast.scheduleSha256)
  expect(forecastNativeCampaign({ fixturePack: input, trainingMilliseconds: [1, 1], elapsedMilliseconds: NATIVE_SKILLOPT_LIMITS.activeMilliseconds }).status).toBe("BUDGET_FORECAST_REFUSED")
})

test("missing or invalid timings cannot masquerade as observed zero latency", () => {
  const input = pack()
  for (const samples of [[NaN, 0], [-1, 0], [Infinity, 0], [0], [0, undefined]]) {
    expect(() => forecastNativeCampaign({ fixturePack: input, trainingMilliseconds: samples as unknown as readonly [number, number], elapsedMilliseconds: 0 })).toThrow("campaign_forecast_invalid")
  }
  const zero = forecastNativeCampaign({ fixturePack: input, trainingMilliseconds: [0, 0], elapsedMilliseconds: 0 })
  expect(zero.conservativeTargetMilliseconds).toBe(0)
  expect(zero.remainingEstimateMilliseconds).toBe((40 + 2 + 16) * 120000)
})

const originalSkill = `---\nname: llm-wiki\ndescription: Synthetic protocol fixture\n---\n\n${COMPILE_ANCHOR}3. Preserve existing content.\n`
const fragment = "Preserve supported facts and cite the supplied evidence before proposing a bounded update."
function wireFixture() {
  const fixturePack = pack()
  const wire = createNativeTrainerWire({ fixturePack, runId: "wire_run", originalSkill, sourceLockSha256: "b".repeat(64) })
  const schedule = buildNativeCampaignSchedule(fixturePack)
  let sequence = 0
  const rollout = (item: { caseId: string; replicate: number }, split: string, value = "") => ({
    schema: "skillopt.rollout-request.v1", runId: "wire_run", requestId: `wire_run:${++sequence}`,
    split, ...item, fragment: value,
  })
  const optimizer = (number = 1) => ({
    schema: "skillopt.native-optimizer-request.v1", runId: "wire_run", requestId: `wire_run:optimizer:${number}`,
    role: "optimizer", phase: "train", stage: "analyst", maxCompletionTokens: 16384,
    messages: [{ role: "system", content: "Improve the supplied training behavior." }, { role: "user", content: "Only approved training observations." }],
  })
  const baseline = () => {
    const accepted: ReturnType<typeof wire.accept>[] = []
    for (const item of schedule.trainerSelection) accepted.push(wire.accept(rollout(item, "selection")))
    for (const item of schedule.training) accepted.push(wire.accept(rollout(item, "train")))
    return accepted
  }
  return { wire, schedule, rollout, optimizer, baseline }
}

test("parent wire follows real selection/train/update/selection rather than relabeling qualification", () => {
  const f = wireFixture()
  const baselineEvents = f.baseline()
  const firstBaseline = baselineEvents[0]
  const firstTraining = baselineEvents[48]
  if (firstBaseline?.kind !== "rollout" || firstTraining?.kind !== "rollout") throw new Error("baseline wire fixture failed")
  expect(Object.isFrozen(firstBaseline)).toBe(true)
  expect(firstBaseline).toMatchObject({ ordinal: 1, cohort: "baseline-selection", fragmentSha256: sha256("") })
  expect(firstTraining).toMatchObject({ ordinal: 49, cohort: "training", fragmentSha256: sha256("") })
  expect(f.wire.snapshot().rollouts).toBe(72)
  const request = f.wire.accept(f.optimizer())
  expect(request.kind).toBe("optimizer")
  if (request.kind !== "optimizer") throw new Error("optimizer wire fixture failed")
  expect(Object.isFrozen(request)).toBe(true)
  expect(request.ordinal).toBe(73)
  expect(request.prompt).toContain("Only approved training observations.")
  expect(request.requestedMaxCompletionTokens).toBe(16384)
  const candidateEvents = f.schedule.trainerSelection.map(item => f.wire.accept(f.rollout(item, "selection", fragment)))
  const firstCandidate = candidateEvents[0]
  if (firstCandidate?.kind !== "rollout") throw new Error("candidate wire fixture failed")
  expect(Object.isFrozen(firstCandidate)).toBe(true)
  expect(firstCandidate).toMatchObject({ ordinal: 74, cohort: "candidate-selection", fragmentSha256: sha256(fragment) })
  expect(firstCandidate).toMatchObject({ caseId: firstBaseline.caseId, replicate: firstBaseline.replicate })
  expect(firstCandidate.cohort).not.toBe(firstBaseline.cohort)
  expect(f.wire.assertComplete()).toEqual({ fragment, candidateSha256: sha256(assembleSkill(originalSkill, fragment)) })
  expect(f.wire.snapshot().rollouts).toBe(120)
  expect(f.schedule.qualification).toHaveLength(312)
})

test("schedule grammar core accepts only an immutable builder-issued schedule", () => {
  const schedule = buildNativeCampaignSchedule(pack())
  expect(() => createNativeTrainerWireForSchedule({
    schedule: { ...schedule }, runId: "wire_run", originalSkill,
  })).toThrow("trainer_schedule_invalid")
  expect(() => createNativeTrainerWireForSchedule({ schedule, runId: "bad run id", originalSkill }))
    .toThrow("trainer_schedule_invalid")
  expect(() => createNativeTrainerWire({
    fixturePack: pack(), runId: "wire_run", originalSkill, sourceLockSha256: "not-a-source-lock-hash",
  })).toThrow("campaign_manifest_invalid")
  expect(createNativeTrainerWireForSchedule({ schedule, runId: "wire_run", originalSkill }).snapshot().rollouts).toBe(0)
})

test("the worker cannot reorder training before its real baseline selection or ask for holdouts", () => {
  for (const split of ["train", "final", "safety"]) {
    const f = wireFixture()
    expect(() => f.wire.accept(f.rollout({ caseId: `${split}-0`, replicate: 0 }, split))).toThrow("trainer_schedule_invalid")
    expect(f.wire.snapshot().rollouts).toBe(0)
    expect(() => f.wire.accept(f.rollout(f.schedule.trainerSelection[0]!, "selection"))).toThrow("trainer_protocol_stopped")
  }
})

test("wire IDs, repeated cases, and premature optimizer requests are refused before dispatch", () => {
  const duplicate = wireFixture()
  duplicate.wire.accept(duplicate.rollout(duplicate.schedule.trainerSelection[0]!, "selection"))
  expect(() => duplicate.wire.accept(duplicate.rollout(duplicate.schedule.trainerSelection[0]!, "selection"))).toThrow("trainer_schedule_invalid")
  const wrongId = wireFixture()
  expect(() => wrongId.wire.accept({ ...wrongId.rollout(wrongId.schedule.trainerSelection[0]!, "selection"), requestId: "other:1" })).toThrow("trainer_protocol_invalid")
  const earlyOptimizer = wireFixture()
  expect(() => earlyOptimizer.wire.accept(earlyOptimizer.optimizer())).toThrow("trainer_protocol_invalid")
})

test("selection labels follow grammar order rather than fragment truthiness", () => {
  const truthyBaseline = wireFixture()
  expect(() => truthyBaseline.wire.accept(
    truthyBaseline.rollout(truthyBaseline.schedule.trainerSelection[0]!, "selection", fragment),
  )).toThrow("trainer_schedule_invalid")
  expect(() => truthyBaseline.wire.accept(
    truthyBaseline.rollout(truthyBaseline.schedule.trainerSelection[0]!, "selection"),
  )).toThrow("trainer_protocol_stopped")

  const emptyCandidate = wireFixture()
  emptyCandidate.baseline()
  emptyCandidate.wire.accept(emptyCandidate.optimizer())
  expect(() => emptyCandidate.wire.accept(
    emptyCandidate.rollout(emptyCandidate.schedule.trainerSelection[0]!, "selection"),
  )).toThrow("trainer_schedule_invalid")
})

test("one candidate fragment is frozen across all upstream selection replicates", () => {
  const f = wireFixture()
  f.baseline()
  f.wire.accept(f.optimizer())
  f.wire.accept(f.rollout(f.schedule.trainerSelection[0]!, "selection", fragment))
  expect(() => f.wire.accept(f.rollout(f.schedule.trainerSelection[1]!, "selection", `${fragment} Retain conflicts.`))).toThrow("trainer_schedule_invalid")
  expect(() => f.wire.assertComplete()).toThrow("trainer_schedule_incomplete")
})

test("optimizer role, prompt scope, and 96KiB serialized prompt limits stay strict", () => {
  for (const mutate of [
    (value: ReturnType<ReturnType<typeof wireFixture>["optimizer"]>) => ({ ...value, phase: "final" }),
    (value: ReturnType<ReturnType<typeof wireFixture>["optimizer"]>) => ({ ...value, stage: "tools" }),
    (value: ReturnType<ReturnType<typeof wireFixture>["optimizer"]>) => ({ ...value, maxCompletionTokens: 16385 }),
    (value: ReturnType<ReturnType<typeof wireFixture>["optimizer"]>) => ({ ...value, messages: [{ role: "system", content: "x" }, { role: "user", content: "x".repeat(96 * 1024) }] }),
  ]) {
    const f = wireFixture()
    f.baseline()
    expect(() => f.wire.accept(mutate(f.optimizer()))).toThrow()
    expect(f.wire.snapshot().optimizerRequests).toBe(0)
  }
})

test("wire frame accessors are rejected without invoking them", () => {
  const f = wireFixture()
  let calls = 0
  const frame = Object.defineProperty({}, "schema", { enumerable: true, get() { calls++; return "skillopt.rollout-request.v1" } })
  expect(() => f.wire.accept(frame)).toThrow("trainer_protocol_invalid")
  expect(calls).toBe(0)
})

test("optimizer message accessors are rejected without invoking them", () => {
  const f = wireFixture()
  f.baseline()
  let calls = 0
  const frame = f.optimizer()
  Object.defineProperty(frame.messages, "0", {
    enumerable: true,
    get() { calls++; return { role: "system", content: "unexpected getter" } },
  })
  expect(() => f.wire.accept(frame)).toThrow("trainer_protocol_invalid")
  expect(calls).toBe(0)
  expect(f.wire.snapshot().optimizerRequests).toBe(0)
})
