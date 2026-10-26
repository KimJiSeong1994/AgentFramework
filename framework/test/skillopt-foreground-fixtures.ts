import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"
import {
  NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT, NATIVE_WIKI_OUTPUT_SCHEMA,
  NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS, NATIVE_WIKI_STRATA,
  type NativeWikiFixture, type NativeWikiFixturePack,
} from "../src/skillopt/dataset.ts"
import { NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA } from "../src/skillopt/evaluation.ts"
import { canonicalJson, sha256 } from "../src/skillopt/pilot.ts"

export const automaticCandidateInstruction = "Preserve supported observations with precise citations."

function makeAutomaticFixture(split: (typeof NATIVE_WIKI_SPLITS)[number], index: number): NativeWikiFixture {
  const id = `${split}-${index}`
  const stratum = NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]
  if (!stratum) throw new Error("automatic campaign fixture stratum is missing")
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const original = `The original observation for ${id}.`
  const correction = `The correction for ${id}.`
  const sourceContent = `${original}\n${correction}\n`
  const sourceSha256 = sha256(sourceContent)
  const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
  const factLine = (statement: string) =>
    `- ${escape(statement)} ([${escape(sourceId)}](../sources/documents-${sourceSha256}.md))`
  const [conflictLeft, conflictRight] = [original, correction].sort()
  const conflictLine = `- ${escape(conflictLeft)} ↔ ${escape(conflictRight)} — retain-both.`
  const existingContent = stratum === "dedup-resume"
    ? `${factLine(original)}\n`
    : stratum === "ownership-injection"
      ? `${factLine(original)}\n${factLine(correction)}\n${conflictLine}\n`
      : "Previous observation.\n"
  return {
    id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split, stratum,
    authorship: "agent-authored",
    sources: [{ id: sourceId, provenance: "raw", content: sourceContent, sha256: sourceSha256 }],
    task: `Integrate the observations for ${id} in [[slot:${slotId}]] and preserve the previous report.`,
    outputSlots: [{ id: slotId, kind: "page", existingContent }],
    assertions: {
      facts: [
        { id: `fact-${id}-original`, slotId, statement: original, sourceIds: [sourceId] },
        { id: `fact-${id}-correction`, slotId, statement: correction, sourceIds: [sourceId] },
      ],
      citations: [
        { factId: `fact-${id}-original`, sourceId },
        { factId: `fact-${id}-correction`, sourceId },
      ],
      contradictions: [{ leftFactId: `fact-${id}-original`, rightFactId: `fact-${id}-correction`, expected: "retain-both" }],
      deduplication: [{ slotId, expected: "reuse-existing" }],
      ownership: [{ slotId, expected: stratum === "ownership-injection" ? "preserve-existing" : "append-only" }],
    },
    forbiddenChanges: [...NATIVE_PROTECTED_CHANGES],
  }
}

export function makeAutomaticPack(): NativeWikiFixturePack {
  return {
    schema: NATIVE_FIXTURE_PACK_SCHEMA,
    contract: NATIVE_WIKI_CONTRACT,
    fixtures: NATIVE_WIKI_SPLITS.flatMap(split =>
      Array.from({ length: NATIVE_WIKI_SPLIT_MINIMUMS[split] }, (_, index) => makeAutomaticFixture(split, index))),
  }
}

function automaticSlotPath(slot: NativeWikiFixture["outputSlots"][number]): string {
  switch (slot.kind) {
    case "page": return `knowledge/wiki/concepts/${slot.id}.md`
    case "annotation": return `knowledge/wiki/sources/annotations/${slot.id}.md`
    case "index": return "knowledge/wiki/index.md"
    case "ingest": return `knowledge/wiki/reports/fixture-ingest-${slot.id}.md`
    case "report": return `knowledge/wiki/reports/fixture-report-${slot.id}.md`
  }
}

function automaticRenderedFactLine(fixture: NativeWikiFixture, slot: NativeWikiFixture["outputSlots"][number],
  fact: NativeWikiFixture["assertions"]["facts"][number]): string {
  const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
  const citations = fact.sourceIds.map(sourceId => {
    const source = fixture.sources.find(item => item.id === sourceId)
    if (!source) throw new Error("automatic fixture fact source is missing")
    const sourcePage = source.provenance === "raw"
      ? `knowledge/wiki/sources/documents-${source.sha256}.md`
      : `knowledge/wiki/concepts/fixture-evidence/${source.id}.md`
    return `[${escape(sourceId)}](${relative(dirname(automaticSlotPath(slot)), sourcePage)})`
  })
  return `- ${escape(fact.statement)} (${citations.join(", ")})`
}

function automaticRenderedContradictionLine(fixture: NativeWikiFixture,
  item: NativeWikiFixture["assertions"]["contradictions"][number]): string {
  const facts = new Map(fixture.assertions.facts.map(fact => [fact.id, fact]))
  const left = facts.get(item.leftFactId)
  const right = facts.get(item.rightFactId)
  if (!left || !right) throw new Error("automatic fixture contradiction fact is missing")
  const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
  const [leftStatement, rightStatement] = [left.statement, right.statement].sort()
  return `- ${escape(leftStatement)} ↔ ${escape(rightStatement)} — ${item.expected}.`
}

export function automaticFixtureResponse(fixture: NativeWikiFixture, candidate: boolean): string {
  const factsById = new Map(fixture.assertions.facts.map(fact => [fact.id, fact]))
  const writes = fixture.outputSlots.map(slot => {
    const ownership = fixture.assertions.ownership.find(item => item.slotId === slot.id)
    const action = ownership?.expected === "preserve-existing" ? "preserve"
      : ownership?.expected === "reject-unowned" ? "reject" : "append"
    const facts = candidate && action === "append"
      ? fixture.assertions.facts.filter(fact => fact.slotId === slot.id &&
        !slot.existingContent.split(/\r?\n/u).includes(automaticRenderedFactLine(fixture, slot, fact)))
        .map(fact => ({ statement: fact.statement, citations: [...fact.sourceIds].sort() }))
        .sort((left, right) => left.statement < right.statement ? -1 : left.statement > right.statement ? 1 : 0)
      : []
    const contradictions = candidate && action === "append"
      ? fixture.assertions.contradictions.filter(item => factsById.get(item.leftFactId)?.slotId === slot.id &&
        !slot.existingContent.split(/\r?\n/u).includes(automaticRenderedContradictionLine(fixture, item)))
        .map(item => {
          const left = factsById.get(item.leftFactId)!
          const right = factsById.get(item.rightFactId)!
          const [leftStatement, rightStatement] = [left.statement, right.statement].sort()
          return { leftStatement, rightStatement, resolution: item.expected }
        })
        .sort((left, right) => {
          const leftKey = `${left.leftStatement}:${left.rightStatement}`
          const rightKey = `${right.leftStatement}:${right.rightStatement}`
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
        })
      : []
    const answer = { schema: NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA, action, facts, contradictions }
    return { slotId: slot.id, content: canonicalJson(answer) }
  })
  return canonicalJson({ schema: NATIVE_WIKI_OUTPUT_SCHEMA, writes })
}

export type SyntheticForegroundModels = Readonly<{
  generator: Readonly<{ engine: "codex" | "claude"; requestedModel: string }>
  target: Readonly<{ engine: "codex" | "claude"; requestedModel: string }>
  reviewer: Readonly<{ engine: "codex" | "claude"; requestedModel: string }>
}>

export type SyntheticForegroundInvocation = Readonly<{
  engine: "codex" | "claude"
  model: string
  mode: "campaign" | "canary"
  role: "target" | "optimizer" | "reviewer" | "unexpected"
  status: "completed" | "unexpected"
}>

type ResponseConfiguration = Readonly<{
  mode: "closed" | "campaign" | "canary"
  models: SyntheticForegroundModels
  optimizerResponse: string
  reviewerResponse: string
  candidateInstruction: string
  fixtures: readonly Readonly<{ task: string; baseline: string; candidate: string }>[]
  canaryTask?: string
  canaryResponse?: string
}>

const SYNTHETIC_CLI_SOURCE = `
const fs = require("node:fs")
const path = require("node:path")
const engine = path.basename(process.argv[1])
if (engine !== expectedEngine) throw new Error("unexpected synthetic CLI engine name")
const directory = path.dirname(process.argv[1])
let prompt = ""
const append = (name, value) => fs.appendFileSync(path.join(directory, name), JSON.stringify(value) + "\\n")
;(async () => {
  for await (const chunk of process.stdin) prompt += chunk.toString("utf8")
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--version") {
    append("probes.jsonl", { engine })
    process.stdout.write(engine === "codex" ? "codex-cli 0.163.0\\n" : "2.1.301 (Claude Code)\\n")
    return
  }
  const config = JSON.parse(fs.readFileSync(path.join(directory, "responses.json"), "utf8"))
  const modelFlag = engine === "codex" ? "-m" : "--model"
  const modelIndex = args.indexOf(modelFlag)
  const model = modelIndex >= 0 ? args[modelIndex + 1] : ""
  const matches = Object.entries(config.models).filter(([, configured]) =>
    configured.engine === engine && configured.requestedModel === model)
  const selected = matches.length === 1 ? matches[0][0] : "unexpected"
  let response
  if (config.mode === "campaign") {
    if (selected === "generator") response = config.optimizerResponse
    else if (selected === "reviewer") response = config.reviewerResponse
    else if (selected === "target") {
      const fixture = config.fixtures.find(item => prompt.includes(item.task))
      if (fixture) response = prompt.includes(config.candidateInstruction) ? fixture.candidate : fixture.baseline
    }
  } else if (config.mode === "canary" && selected === "target" &&
      typeof config.canaryTask === "string" && prompt.includes(config.canaryTask)) {
    response = config.canaryResponse
  }
  const status = typeof response === "string" && response.length > 0 ? "completed" : "unexpected"
  append("invocations.jsonl", { engine, model, mode: config.mode,
    role: selected === "generator" ? "optimizer" : selected, status })
  if (status !== "completed") {
    process.stderr.write("synthetic CLI rejected an unmapped request\\n")
    process.exitCode = 1
    return
  }
  if (engine === "codex") {
    const records = [
      { type: "thread.started", thread_id: "synthetic-thread" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: response } },
      { type: "turn.completed", usage: {} },
    ]
    process.stdout.write(records.map(record => JSON.stringify(record)).join("\\n") + "\\n")
    return
  }
  const session = "synthetic-claude-session"
  const records = [
    { type: "system", subtype: "init", session_id: session, tools: [], mcp_servers: [] },
    { type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "text", text: response }] } },
    { type: "result", subtype: "success", is_error: false, result: response, permission_denials: [], session_id: session },
  ]
  process.stdout.write(records.map(record => JSON.stringify(record)).join("\\n") + "\\n")
})().catch(() => {
  process.stderr.write("synthetic CLI protocol failure\\n")
  process.exitCode = 1
})
`

export function createSyntheticForegroundCli(input: Readonly<{
  models: SyntheticForegroundModels
  fixturePack: NativeWikiFixturePack
}>): Readonly<{
  directory: string
  codexExecutable: string
  claudeExecutable: string
  codexExecutableSha256: string
  claudeExecutableSha256: string
  useCampaignResponses(): void
  useCanaryResponse(fixture: NativeWikiFixture): void
  invocations(): readonly SyntheticForegroundInvocation[]
  dispose(): void
}> {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "skillopt-foreground-cli-")))
  const codexExecutable = join(directory, "codex")
  const claudeExecutable = join(directory, "claude")
  const executableBytes = (engine: "codex" | "claude") =>
    Buffer.from(`#!${process.execPath} --no-env-file\nconst expectedEngine = ${JSON.stringify(engine)}\n${SYNTHETIC_CLI_SOURCE}\n`, "utf8")
  try {
    writeFileSync(codexExecutable, executableBytes("codex"), { mode: 0o700, flag: "wx" })
    chmodSync(codexExecutable, 0o700)
    writeFileSync(claudeExecutable, executableBytes("claude"), { mode: 0o700, flag: "wx" })
    chmodSync(claudeExecutable, 0o700)
    writeFileSync(join(directory, "responses.json"), "{}", { mode: 0o600, flag: "wx" })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }

  const writeConfiguration = (configuration: ResponseConfiguration): void => {
    writeFileSync(join(directory, "responses.json"), JSON.stringify(configuration), { mode: 0o600 })
  }
  return Object.freeze({
    directory,
    codexExecutable,
    claudeExecutable,
    codexExecutableSha256: sha256(readFileSync(codexExecutable)),
    claudeExecutableSha256: sha256(readFileSync(claudeExecutable)),
    useCampaignResponses() {
      const edit = { op: "append", content: automaticCandidateInstruction }
      // One coherent completion carries the fields validated by the pinned analyst, merge, and ranking stages.
      writeConfiguration({
        mode: "campaign",
        models: input.models,
        optimizerResponse: canonicalJson({ patch: { reasoning: "Preserve fixture-supported observations.", edits: [edit] },
          edits: [edit], selected_indices: [0] }),
        reviewerResponse: canonicalJson({ schema: "skillopt.semantic-review.v1", assessment: "clear", findings: [] }),
        candidateInstruction: automaticCandidateInstruction,
        fixtures: input.fixturePack.fixtures.map(fixture => ({ task: fixture.task,
          baseline: automaticFixtureResponse(fixture, false), candidate: automaticFixtureResponse(fixture, true) })),
      })
    },
    useCanaryResponse(fixture: NativeWikiFixture) {
      if (fixture.split !== "dev") throw new Error("synthetic native-load response must use a dev fixture")
      writeConfiguration({
        mode: "canary",
        models: input.models,
        optimizerResponse: "",
        reviewerResponse: "",
        candidateInstruction: automaticCandidateInstruction,
        fixtures: [],
        canaryTask: fixture.task,
        canaryResponse: automaticFixtureResponse(fixture, true),
      })
    },
    invocations() {
      try {
        return readFileSync(join(directory, "invocations.jsonl"), "utf8").trimEnd().split("\n")
          .filter(Boolean).map(line => JSON.parse(line) as SyntheticForegroundInvocation)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
      }
    },
    dispose() { rmSync(directory, { recursive: true, force: true }) },
  })
}
