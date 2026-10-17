import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  truncateSync, writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { recordToolOutcome } from "../src/telemetry/outcomes.ts"
import { recordRoutingAdvice, recordRoutingDecision, routingLogPath, type RoutingDecision } from "../src/telemetry/routing.ts"
import { stateRoot } from "../src/state/store.ts"
import { readRoutingLogs } from "../src/telemetry/routing-reader.ts"
import { createHash } from "node:crypto"
import {
  activateSkillCampaign, admitSkillCall, listSkillObservations, recordSkillCall, recordSkillTurn,
  type SkillObservationList,
} from "../src/telemetry/skills.ts"
import { RETURNED_BODY_BASIS, RETURNED_PAYLOAD_BASIS } from "../src/telemetry/skill-evaluation.ts"
import { captureWiki, lintWiki, parseLog, registerWiki, statusWiki, summarizeOutcomes, unlockWiki } from "../src/wiki/wiki.ts"

let root: string
let state: string
let oldState: string | undefined
let docsDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-wiki-"))
  state = mkdtempSync(join(tmpdir(), "otter-wiki-state-"))
  docsDir = mkdtempSync(join(tmpdir(), "otter-wiki-docs-"))
  oldState = process.env.OTTER_STATE_HOME
  process.env.OTTER_STATE_HOME = state
  mkdirSync(join(root, "knowledge", "wiki"), { recursive: true })
  writeFileSync(join(root, "knowledge", "AGENTS.md"), "# Schema\nRaw sources are immutable; log is append-only.\n")
  writeFileSync(join(root, "knowledge", "wiki", "index.md"), "# Index\n\n[Log](log.md)\n[Report](reports/tool-outcomes.md)\n")
  writeFileSync(join(root, "knowledge", "wiki", "log.md"), "# Log\n")
  // The real wiki always has the generated report; capture regenerates it.
  mkdirSync(join(root, "knowledge", "wiki", "reports"), { recursive: true })
  writeFileSync(join(root, "knowledge", "wiki", "reports", "tool-outcomes.md"), "# Report\n\n[Index](../index.md)\n")
})
afterEach(() => {
  if (oldState === undefined) delete process.env.OTTER_STATE_HOME
  else process.env.OTTER_STATE_HOME = oldState
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
function routingDecision(decisionID: string, overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    decisionID, sessionID: "session-1", messageID: `message-${decisionID}`, mode: "suggest", skill: "skill-one",
    reason: "recommended", elapsedMs: 120, requestSent: true, candidates: ["skill-one", "skill-two"],
    thresholds: { minProbability: 0.65, minMargin: 0.1, timeoutMs: 1000 },
    scores: { choice: "skill-one", probabilities: { "skill-one": 0.75, "skill-two": 0.15, none: 0.1 }, confidence: 0.75, margin: 0.6 },
    ...overrides,
  }
}
function recordDecision(decision: RoutingDecision) {
  recordRoutingDecision({ worktree: root, log: () => { } } as never, decision)
}
function routingFile(sessionID = "session-1"): string {
  const path = routingLogPath(root, sessionID)
  mkdirSync(dirname(path), { recursive: true })
  return path
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
function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys((value as Record<string, unknown>)[key])]))
}
function skillSnapshotText(observations: SkillObservationList): string {
  const facts = [...observations.facts].sort((left, right) =>
    left.kind < right.kind ? -1 : left.kind > right.kind ? 1 :
      left.sessionID < right.sessionID ? -1 : left.sessionID > right.sessionID ? 1 :
        left.factKey < right.factKey ? -1 : left.factKey > right.factKey ? 1 : 0)
  return `${JSON.stringify(sortJsonKeys({
    schemaVersion: 1, kind: "skill-observation-snapshot", observations: { ...observations, facts },
  }), null, 2)}\n`
}

// -- Existing capture behaviour (kept meaningful with the new shared lock/log grammar) -----------------------------

test("routing capture joins applied advice and supports immutable replay and compile status", () => {
  const decision = routingDecision("d1")
  recordDecision(decision)
  recordRoutingAdvice({ worktree: root, log: () => {} } as never, decision.sessionID, decision.messageID, decision.decisionID, decision.skill!)
  const first = captureWiki(root).routing
  expect(first.events).toBe(2)
  expect(first.decisions).toBe(1)
  const report = readFileSync(join(root, first.report), "utf8")
  expect(report).toContain("exactly matched suggest recommendations: 1")
  expect(report).toContain("not evidence of skill execution")
  const before = readFileSync(join(root, first.source), "utf8")
  const log = readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")
  expect(statusWiki(root).pending.some((item) => item.kind === "routing")).toBe(true)
  expect(captureWiki(root).routing).toMatchObject({ source: first.source, created: false })
  expect(readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")).toBe(log)
  appendFileSync(join(root, "knowledge/wiki/log.md"), `\n## [2026-10-02T00:00:00Z] ingest | Routing review\n\n- [Source](sources/${first.summary.split("/").at(-1)})\n`)
  expect(statusWiki(root).pending.some((item) => item.kind === "routing")).toBe(false)
  recordDecision(routingDecision("d2"))
  const second = captureWiki(root).routing
  expect(second.source).not.toBe(first.source)
  expect(readFileSync(join(root, first.source), "utf8")).toBe(before)
  expect(lintWiki(root)).toEqual([])
})

test("routing reports separate shadow abstentions and unmatched applications", () => {
  recordDecision(routingDecision("shadow", { mode: "shadow" }))
  recordDecision(routingDecision("abstain", { skill: null, reason: "abstained", thresholds: { minProbability: 0.99, minMargin: 0.2, timeoutMs: 1000 } }))
  const deps = { worktree: root, log: () => {} } as never
  recordRoutingAdvice(deps, "session-1", "message-shadow", "shadow", "skill-one")
  recordRoutingAdvice(deps, "session-1", "message-missing", "missing", "skill-one")
  const receipt = captureWiki(root).routing
  const report = readFileSync(join(root, receipt.report), "utf8")
  expect(report).toContain("| shadow | 1 |")
  expect(report).toContain("| abstained | 1 |")
  expect(report).toContain("exactly matched suggest recommendations: 0")
  expect(report).toContain("unmatched applications: 1")
  expect(report).toContain("conflicting or ineligible applications: 1")
})

test("routing import projects metadata and records malformed torn and mismatched lines without their text", () => {
  recordDecision(routingDecision("d1"))
  const path = routingFile()
  const event = JSON.parse(readFileSync(path, "utf8"))
  event.prompt = "PRIVATE_SENTINEL"
  event.scores.raw = "PRIVATE_SENTINEL"
  event.thresholds.note = "PRIVATE_SENTINEL"
  const mismatch = { ...event, eventID: "mismatch", sessionID: "another-session" }
  const bad = { ...event, eventID: "bad", scores: { ...event.scores, probabilities: { unexpected: 1 } } }
  writeFileSync(path, [event, mismatch, bad].map((row) => JSON.stringify(row)).join("\n") + "\nPRIVATE_SENTINEL\n{\"incomplete\":")
  const receipt = captureWiki(root).routing
  expect(receipt.coverage).toMatchObject({ valid: 1, invalid: 4, scanned: 5 })
  const raw = readFileSync(join(root, receipt.source), "utf8")
  expect(raw).not.toContain("PRIVATE_SENTINEL")
  expect(raw).not.toContain("incomplete")
  expect(raw).toContain("torn_line")
  expect(raw).toContain("session_mismatch")
  expect(lintWiki(root)).toEqual([])
})

test("routing duplicate event IDs deduplicate but conflicting replays refuse before wiki mutation", () => {
  recordDecision(routingDecision("d1"))
  const path = routingFile()
  const row = readFileSync(path, "utf8")
  appendFileSync(path, row)
  expect(readRoutingLogs(root).coverage).toMatchObject({ valid: 1, duplicates: 1, scanned: 2 })
  const event = JSON.parse(row)
  event.elapsedMs++
  appendFileSync(path, JSON.stringify(event) + "\n")
  const before = snapshot()
  expect(() => captureWiki(root)).toThrow("Conflicting routing eventID")
  expect(snapshot()).toBe(before)
})

test("routing reader refuses symlink log and directory before capture writes", () => {
  const path = routingFile()
  const target = doc("external.txt", "{}\n")
  symlinkSync(target, path)
  const before = snapshot()
  expect(() => captureWiki(root)).toThrow()
  expect(snapshot()).toBe(before)
  rmSync(dirname(path), { recursive: true })
  symlinkSync(docsDir, dirname(path))
  expect(() => captureWiki(root)).toThrow()
  expect(snapshot()).toBe(before)
})

test("routing byte and event limits disclose bounded coverage", () => {
  const path = routingFile()
  writeFileSync(path, " ".repeat(1024 * 1024 + 1))
  const bytes = readRoutingLogs(root)
  expect(bytes.coverage).toMatchObject({ truncated: true, scope: "bounded" })
  expect(bytes.coverage.truncationReasons).toContain("file_bytes")
  writeFileSync(path, "{}\n".repeat(10001))
  const events = readRoutingLogs(root)
  expect(events.coverage).toMatchObject({ scanned: 10000, invalid: 10000, truncated: true })
  expect(events.coverage.truncationReasons).toContain("event_limit")
})

test("routing file and directory limits disclose bounded coverage", () => {
  const dir = dirname(routingFile())
  for (let i = 0; i < 257; i++) writeFileSync(join(dir, `session-${i}.jsonl`), "")
  expect(readRoutingLogs(root).coverage).toMatchObject({ filesScanned: 256, truncated: true, truncationReasons: ["file_limit"] })
  for (let i = 0; i < 4097; i++) writeFileSync(join(dir, `ignored-${i}`), "")
  expect(readRoutingLogs(root).coverage).toMatchObject({ scanned: 0, truncated: true, truncationReasons: ["directory_limit"] })
})

test("routing lint detects raw tampering and rejects nested extra metadata", () => {
  recordDecision(routingDecision("d1"))
  const receipt = captureWiki(root).routing
  const original = readFileSync(join(root, receipt.source), "utf8")
  appendFileSync(join(root, receipt.source), "tampered")
  expect(lintWiki(root).some((problem) => problem.includes("integrity mismatch"))).toBe(true)
  writeFileSync(join(root, receipt.source), original)
  const data = JSON.parse(original)
  data.events[0].scores.privateText = "PRIVATE_SENTINEL"
  const text = JSON.stringify(data) + "\n"
  const id = createHash("sha256").update(text).digest("hex")
  writeFileSync(join(root, "knowledge/raw/routing", `${id}.json`), text)
  expect(lintWiki(root).some((problem) => /routing snapshot (schema|metadata)/.test(problem))).toBe(true)
})

test("routing recommendations without scores or thresholds are not admitted as successful decisions", () => {
  recordDecision(routingDecision("d1"))
  const path = routingFile()
  const valid = JSON.parse(readFileSync(path, "utf8"))
  const invalid = [
    { ...valid, scores: null },
    { ...valid, thresholds: null },
    { ...valid, requestSent: false },
    { ...valid, thresholds: { ...valid.thresholds, minProbability: 0.99 } },
  ]
  writeFileSync(path, invalid.map((row, i) => JSON.stringify({ ...row, eventID: `invalid-${i}` })).join("\n") + "\n")
  expect(readRoutingLogs(root).coverage).toMatchObject({ valid: 0, invalid: 4 })
})

test("empty history is explicitly empty, not fabricated observations", () => {
  const receipt = captureWiki(root)
  expect(receipt.observations).toBe(0)
  expect(receipt.routing.events).toBe(0)
  expect(receipt.routing.coverage.scope).toBe("complete")
  expect(readFileSync(join(root, receipt.report), "utf8")).toContain("아직 기록된 도구 실행이 없습니다")
  expect(receipt.routing.events).toBe(0)
  expect(receipt.routing.coverage).toMatchObject({ scanned: 0, valid: 0, invalid: 0, duplicates: 0, truncated: false, scope: "complete" })
  expect(readFileSync(join(root, receipt.routing.report), "utf8")).toContain("explicit zero-observation evidence")
  expect(lintWiki(root)).toEqual([])
})

test("skill capture exports sanitized core facts, replays immutably, and compiles only its linked source", () => {
  const startedAt = Date.now()
  activateSkillCampaign(root, "wiki-campaign", startedAt)
  recordSkillTurn(root, "wiki-campaign", {
    sessionID: "session_1", messageID: "user_1", phase: "terminal", role: "user",
    closureReason: "completed",
    routerExposure: "suggest", routeDecisionID: "decision_1", routeSkillName: "plan", adviceInserted: true,
    requestEvidence: "unknown",
  }, Date.now())
  recordSkillTurn(root, "wiki-campaign", {
    sessionID: "session_1", messageID: "assistant_1", parentMessageID: "user_1", phase: "terminal", role: "assistant",
  }, Date.now())
  const admission = admitSkillCall(root, "wiki-campaign", {
    sessionID: "session_1", callID: "call_1", stage: "before", requestedName: "plan", routeDecisionID: "decision_1",
  }, Date.now())
  if (!admission.admitted) throw new Error("expected a scratch skill call admission")
  recordSkillCall(root, admission.token, {
    state: "completed", returnedContent: "observed", requestedName: "plan", returnedName: "plan",
    messageID: "assistant_1", routeDecisionID: "decision_1", taskRelation: "unknown",
    returnedPayloadSha256: "a".repeat(64), returnedPayloadBasis: RETURNED_PAYLOAD_BASIS,
    returnedBodySha256: "b".repeat(64), returnedBodyBasis: RETURNED_BODY_BASIS,
  }, Date.now())

  const first = captureWiki(root)
  expect(first.skills).toMatchObject({
    available: true, health: "ok", campaign: { campaignID: "wiki-campaign", status: "open", callCount: 1 },
    evaluation: {
      calls: { includedUniqueCalls: 1, durableQuotaCalls: 1, completedToolCalls: 1 },
      fingerprints: { terminalPayload: { numerator: 1, denominator: 1 }, returnedBody: { numerator: 1, denominator: 1 } },
      advice: { exactExposures: 1, callsJoinedToAdvice: 1, followThrough: { numerator: 1, denominator: 1 }, adherenceClaim: false, causalClaim: false },
    },
  })
  const rawPath = join(root, first.skills.source)
  const originalRaw = readFileSync(rawPath, "utf8")
  const raw = JSON.parse(originalRaw)
  expect(raw).toMatchObject({ schemaVersion: 1, kind: "skill-observation-snapshot", observations: { available: true } })
  expect(raw).not.toHaveProperty("capturedAt")
  const report = readFileSync(join(root, first.skills.report), "utf8")
  expect(report).toContain("exact loaded original file SHA is unavailable")
  expect(report).toContain("not proof of procedure adherence or causal effectiveness")
  expect(report).toContain("terminal-output-utf8.v1")
  expect(report).toContain("opencode-1.18.33.trimmed-content.v1")
  expect(originalRaw).not.toContain("PRIVATE_SENTINEL")

  appendFileSync(join(root, first.skills.summary), "\nManual annotation must survive replay.\n")
  const logBeforeReplay = readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")
  const replay = captureWiki(root)
  expect(replay.skills.created).toBe(false)
  expect(replay.skills.source).toBe(first.skills.source)
  expect(readFileSync(rawPath, "utf8")).toBe(originalRaw)
  expect(readFileSync(join(root, first.skills.summary), "utf8")).toContain("Manual annotation must survive replay.")
  expect(readFileSync(join(root, "knowledge/wiki/log.md"), "utf8")).toBe(logBeforeReplay)

  const beforeIngest = statusWiki(root)
  const otherPending = beforeIngest.pending.filter((item) => item.sourceId !== first.skills.source.split("/").at(-1)!.slice(0, -5))
    .map((item) => item.sourceId).sort()
  appendFileSync(join(root, "knowledge/wiki/log.md"),
    `\n## [2026-10-02T00:00:00Z] ingest | Reviewed skill evidence\n\n[Origin](sources/${first.skills.summary.split("/").at(-1)})\n`)
  const afterIngest = statusWiki(root)
  expect(afterIngest.compiled).toBe(beforeIngest.compiled + 1)
  expect(afterIngest.pending.map((item) => item.sourceId).sort()).toEqual(otherPending)
  expect(lintWiki(root)).toEqual([])
})

test("missing skill observation store is unavailable evidence rather than zero use", () => {
  const receipt = captureWiki(root)
  const raw = JSON.parse(readFileSync(join(root, receipt.skills.source), "utf8"))
  const report = readFileSync(join(root, receipt.skills.report), "utf8")
  expect(receipt.skills).toMatchObject({ available: false, health: "database_missing", campaign: { status: null, callCount: 0 } })
  expect(raw.observations).toMatchObject({ available: false, health: "database_missing", coverage: { populationComplete: false, unscannedTotal: "unknown" } })
  expect(report).toContain("Unavailable, disabled, missing, expired, capped, or closed telemetry is not evidence of zero skill use")
  expect(report).toContain("0/0 (N/A)")
  expect(report).toContain("unobserved population: unknown")
})

test("skill report keeps quota cutoff and censored pending calls distinct from completion", () => {
  const startedAt = Date.now()
  activateSkillCampaign(root, "wiki-cutoff", startedAt)
  for (let index = 0; index < 99; index++) {
    const admission = admitSkillCall(root, "wiki-cutoff", {
      sessionID: "session_1", callID: `call_${index}`, stage: "before", requestedName: "plan",
    }, Date.now())
    if (!admission.admitted) throw new Error("expected admitted scratch skill call")
    recordSkillCall(root, admission.token, {
      state: "completed", returnedContent: "not_returned", requestedName: "plan",
    }, Date.now())
  }
  const pending = admitSkillCall(root, "wiki-cutoff", {
    sessionID: "session_1", callID: "call_99", stage: "before", requestedName: "plan",
  }, Date.now())
  if (!pending.admitted) throw new Error("expected the quota-triggering call to be admitted")

  const receipt = captureWiki(root)
  const report = readFileSync(join(root, receipt.skills.report), "utf8")
  expect(receipt.skills.campaign).toMatchObject({ status: "draining", callCount: 100, cutoffReason: "call_limit", notCollectedAfterStop: true })
  expect(receipt.skills.evaluation.calls).toMatchObject({ includedUniqueCalls: 100, durableQuotaCalls: 100, completedToolCalls: 99, unresolvedCalls: 1, censoredUnresolvedCalls: 1 })
  expect(receipt.skills.evaluation.coverage).toMatchObject({ populationComplete: false, notCollectedAfterStop: true })
  expect(report).toContain("quota calls 100")
  expect(report).toContain("censored unresolved calls: 1")
  expect(report).toContain("population complete: no")
})

test("skill lint rejects nested extra metadata even when its content hash matches its filename", () => {
  const receipt = captureWiki(root)
  const raw = JSON.parse(readFileSync(join(root, receipt.skills.source), "utf8"))
  raw.observations.coverage.privateText = "WIKI_PRIVATE_SENTINEL"
  const tampered = `${JSON.stringify(raw, null, 2)}\n`
  const id = createHash("sha256").update(tampered).digest("hex")
  writeFileSync(join(root, "knowledge/raw/skill-runs", `${id}.json`), tampered, { mode: 0o600 })
  const problems = lintWiki(root)
  expect(problems.some((problem) => problem.includes("Invalid skill observation snapshot schema or metadata"))).toBe(true)
  expect(problems.join("\n")).not.toContain("WIKI_PRIVATE_SENTINEL")
  const beforeCapture = snapshot()
  let errorMessage = ""
  try { captureWiki(root) } catch (error) { errorMessage = (error as Error).message }
  expect(errorMessage).toContain("Invalid skill observation snapshot schema or metadata")
  expect(errorMessage).not.toContain("WIKI_PRIVATE_SENTINEL")
  expect(snapshot()).toBe(beforeCapture)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
})

test("skill capture rejects corrupt hashes, unsafe symlinks, and over-limit files before Wiki writes", () => {
  const first = captureWiki(root)
  const rawPath = join(root, first.skills.source)
  appendFileSync(rawPath, "tampered")
  expect(lintWiki(root).some((problem) => problem.includes("Skill raw source integrity mismatch"))).toBe(true)
  const beforeBadHashCapture = snapshot()
  expect(() => captureWiki(root)).toThrow("Skill raw source integrity mismatch")
  expect(snapshot()).toBe(beforeBadHashCapture)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)

  rmSync(rawPath)
  const outside = mkdtempSync(join(tmpdir(), "otter-skill-wiki-outside-"))
  try {
    const unsafe = join(root, "knowledge/raw/skill-runs", `${"a".repeat(64)}.json`)
    symlinkSync(join(outside, "missing.json"), unsafe)
    const before = snapshot()
    expect(() => captureWiki(root)).toThrow("regular, non-symlink file")
    expect(snapshot()).toBe(before)
    expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
    rmSync(unsafe)

    const oversized = join(root, "knowledge/raw/skill-runs", `${"b".repeat(64)}.json`)
    writeFileSync(oversized, "", { mode: 0o600 })
    truncateSync(oversized, 16 * 1024 * 1024 + 1)
    const beforeOversize = snapshot()
    expect(() => captureWiki(root)).toThrow("exceeds 16777216 bytes")
    expect(snapshot()).toBe(beforeOversize)
    expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
    rmSync(oversized)

    const totalBefore = [
      readFileSync(join(root, "knowledge/wiki/index.md"), "utf8"),
      readFileSync(join(root, "knowledge/wiki/log.md"), "utf8"),
      readFileSync(join(root, "knowledge/wiki/reports/skill-evaluation.md"), "utf8"),
    ]
    for (let index = 0; index < 5; index++) {
      const path = join(root, "knowledge/raw/skill-runs", `${index.toString(16).repeat(64)}.json`)
      writeFileSync(path, "", { mode: 0o600 })
      truncateSync(path, 16 * 1024 * 1024)
    }
    expect(() => captureWiki(root)).toThrow("exceed 67108864 total bytes")
    expect([
      readFileSync(join(root, "knowledge/wiki/index.md"), "utf8"),
      readFileSync(join(root, "knowledge/wiki/log.md"), "utf8"),
      readFileSync(join(root, "knowledge/wiki/reports/skill-evaluation.md"), "utf8"),
    ]).toEqual(totalBefore)
    expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test("skill snapshot cap permits identical replay at 128 files and refuses the next distinct capture", () => {
  const startedAt = Date.now()
  activateSkillCampaign(root, "wiki-cap", startedAt)
  const rawDir = join(root, "knowledge/raw/skill-runs")
  mkdirSync(rawDir, { recursive: true, mode: 0o700 })
  for (let index = 0; index < 128; index++) {
    const observedAt = Date.now()
    recordSkillTurn(root, "wiki-cap", {
      sessionID: "session_1", messageID: `message_${index}`, phase: "terminal", role: "user",
    }, observedAt)
    const content = skillSnapshotText(listSkillObservations(root, { limit: 10_000, observedAt }))
    const id = createHash("sha256").update(content).digest("hex")
    writeFileSync(join(rawDir, `${id}.json`), content, { flag: "wx", mode: 0o600 })
  }

  const replay = captureWiki(root)
  expect(replay.skills.created).toBe(false)
  expect(replay.skills.source).toContain("skill-runs/")
  const beforeOverflow = snapshot()
  recordSkillTurn(root, "wiki-cap", {
    sessionID: "session_1", messageID: "message_overflow", phase: "terminal", role: "user",
  }, Date.now())
  expect(() => captureWiki(root)).toThrow("cap reached (128 snapshots)")
  expect(snapshot()).toBe(beforeOverflow)
  expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
})

test("routing capture exports producer decisions and only verifies exact suggest advice applications", () => {
  recordDecision(routingDecision("decision-1"))
  recordRoutingAdvice({ worktree: root } as never, "session-1", "message-decision-1", "decision-1", "skill-one")
  const receipt = captureWiki(root)
  const raw = JSON.parse(readFileSync(join(root, receipt.routing.source), "utf8"))
  expect(receipt.routing).toMatchObject({ events: 2, decisions: 1, adviceApplied: 1 })
  expect(raw.kind).toBe("jev-routing-snapshot")
  expect(raw.events.map((event: { event: string }) => event.event).sort()).toEqual(["advice_applied", "decision"])
  expect(readFileSync(join(root, receipt.routing.report), "utf8")).toContain("exactly matched suggest recommendations: 1")
  expect(statusWiki(root).pending.some((item) => item.kind === "routing" && item.source === receipt.routing.source)).toBe(true)
  expect(lintWiki(root)).toEqual([])
})

test("shadow abstention is reported as a decision, not as an application or execution", () => {
  recordDecision(routingDecision("shadow-1", {
    mode: "shadow", skill: null, reason: "abstained",
    scores: { choice: "none", probabilities: { "skill-one": 0.1, "skill-two": 0.1, none: 0.8 }, confidence: 0.8, margin: 0.7 },
  }))
  const receipt = captureWiki(root)
  const report = readFileSync(join(root, receipt.routing.report), "utf8")
  expect(receipt.routing).toMatchObject({ events: 1, decisions: 1, adviceApplied: 0 })
  expect(report).toContain("| shadow | 1 |")
  expect(report).toContain("| abstained | 1 |")
  expect(report).toContain("unmatched applications: 0")
  expect(report).toContain("not evidence of skill execution")
})


test("routing capture strips unknown text metadata and visibly rejects malformed, torn, and misfiled rows", () => {
  recordDecision(routingDecision("decision-sanitized"))
  const path = routingFile()
  const event = JSON.parse(readFileSync(path, "utf8"))
  event.userText = "ROUTING_USER_TEXT_SENTINEL"
  event.rawErrorBody = "ROUTING_ERROR_SENTINEL"
  writeFileSync(path, `${JSON.stringify(event)}\n{malformed}\n{torn`)
  const mismatched = { ...event, eventID: "mismatch-event", sessionID: "session-1" }
  writeFileSync(routingFile("other-session"), `${JSON.stringify(mismatched)}\n`)

  const receipt = captureWiki(root)
  const rawText = readFileSync(join(root, receipt.routing.source), "utf8")
  const raw = JSON.parse(rawText)
  const report = readFileSync(join(root, receipt.routing.report), "utf8")
  expect(raw.coverage).toMatchObject({ scanned: 4, valid: 1, invalid: 3 })
  expect(raw.rejected.map((item: { reason: string }) => item.reason).sort()).toEqual(["malformed_json", "session_mismatch", "torn_line"])
  expect(rawText).not.toContain("ROUTING_USER_TEXT_SENTINEL")
  expect(rawText).not.toContain("ROUTING_ERROR_SENTINEL")
  expect(report).toContain("malformed_json")
  expect(report).toContain("torn_line")
  expect(lintWiki(root)).toEqual([])
})

test("routing reader rejects symlinked directories and files before wiki writes", () => {
  const stateDirectory = stateRoot(root)
  mkdirSync(stateDirectory, { recursive: true })
  const outside = mkdtempSync(join(tmpdir(), "otter-routing-outside-"))
  try {
    const before = snapshot()
    symlinkSync(outside, join(stateDirectory, "routing"))
    expect(() => captureWiki(root)).toThrow("Routing state directory must be a real directory")
    expect(snapshot()).toBe(before)
    rmSync(join(stateDirectory, "routing"))
    mkdirSync(join(stateDirectory, "routing"))
    writeFileSync(join(outside, "event.jsonl"), "{}\n")
    symlinkSync(join(outside, "event.jsonl"), join(stateDirectory, "routing", "session-1.jsonl"))
    expect(() => captureWiki(root)).toThrow("Routing log must be a regular, non-symlink file")
    expect(snapshot()).toBe(before)
    expect(existsSync(join(root, "knowledge/.wiki.lock"))).toBe(false)
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test("routing reader reports byte and directory bounds without inventing totals", () => {
  const stateDirectory = stateRoot(root)
  const routingDirectory = join(stateDirectory, "routing")
  mkdirSync(routingDirectory, { recursive: true })
  writeFileSync(join(routingDirectory, "session-1.jsonl"), "x".repeat(1024 * 1024 + 1))
  const byBytes = captureWiki(root)
  expect(byBytes.routing.coverage).toMatchObject({ scope: "bounded", truncated: true })
  expect(byBytes.routing.coverage.truncationReasons).toContain("file_bytes")

  rmSync(routingDirectory, { recursive: true, force: true })
  mkdirSync(routingDirectory, { recursive: true })
  for (let i = 0; i < 4097; i++) writeFileSync(join(routingDirectory, `noise-${i}.txt`), "")
  const byDirectory = captureWiki(root)
  expect(byDirectory.routing.coverage).toMatchObject({ filesScanned: 0, scanned: 0, scope: "bounded", truncated: true })
  expect(byDirectory.routing.coverage.truncationReasons).toContain("directory_limit")
  expect(readFileSync(join(root, byDirectory.routing.report), "utf8")).toContain("No unscanned total is inferred")
})

test("routing status compile and lint pair only through the indexed routing source page", () => {
  recordDecision(routingDecision("decision-status"))
  const receipt = captureWiki(root)
  const pageName = receipt.routing.summary.split("/").pop()!
  let status = statusWiki(root)
  expect(status.pending.some((item) => item.kind === "routing" && item.sourceId === pageName.slice("routing-".length, -".md".length))).toBe(true)
  appendFileSync(join(root, "knowledge/wiki/log.md"), `\n## [2026-01-01T00:00:00Z] ingest | routing findings\n\n[origin](sources/${pageName})\n`)
  status = statusWiki(root)
  expect(status.compiled).toBe(1)
  expect(status.pending.some((item) => item.kind === "routing")).toBe(false)
  expect(lintWiki(root)).toEqual([])

  appendFileSync(join(root, receipt.routing.source), "tampered")
  expect(lintWiki(root).some((problem) => problem.includes("integrity mismatch"))).toBe(true)
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
  const script = join(import.meta.dir, "../../scripts/otter-wiki.ts")
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
  const r = spawnSync("bun", [join(import.meta.dir, "../../scripts/otter-wiki.ts"), "status", "--root", root], { encoding: "utf8" })
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
  const outside = mkdtempSync(join(tmpdir(), "otter-wiki-outside-"))
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
  const outside = mkdtempSync(join(tmpdir(), "otter-wiki-outside-"))
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
  const outside = mkdtempSync(join(tmpdir(), "otter-wiki-outside-"))
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
  return spawnSync("bun", [join(import.meta.dir, "..", "..", "scripts", "otter-wiki.ts"), ...args], { encoding: "utf8" })
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
  const cliRoot = mkdtempSync(join(tmpdir(), "otter-wiki-cli-"))
  const cliState = mkdtempSync(join(tmpdir(), "otter-wiki-cli-state-"))
  try {
    mkdirSync(join(cliRoot, "knowledge", "wiki"), { recursive: true })
    writeFileSync(join(cliRoot, "knowledge", "AGENTS.md"), "# Schema\n")
    writeFileSync(join(cliRoot, "knowledge", "wiki", "index.md"), "# Index\n")
    writeFileSync(join(cliRoot, "knowledge", "wiki", "log.md"), "# Log\n")
    const result = spawnSync("bun", [join(import.meta.dir, "..", "..", "scripts", "otter-wiki.ts"), "status", "--root", cliRoot],
      { encoding: "utf8", env: { ...process.env, OTTER_STATE_HOME: cliState } })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({ sources: 0, compiled: 0, pending: [], problems: [] })
  } finally {
    rmSync(cliRoot, { recursive: true, force: true })
    rmSync(cliState, { recursive: true, force: true })
  }
})
