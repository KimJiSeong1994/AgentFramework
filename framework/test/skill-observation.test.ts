import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  activateSkillCampaign, admitSkillCall, getSkillCampaignStatus, listSkillObservations,
  bestEffortSkillObservation, recordSkillCall, recordSkillTask, recordSkillTurn, recordSkillVerification,
  skillObservationDatabasePath, validateSkillObservationSnapshot,
} from "../src/telemetry/skills.ts"
import {
  OBSERVED_FILE_BASIS, RETURNED_BODY_BASIS, RETURNED_PAYLOAD_BASIS, SUPPORTED_SKILL_RENDERER,
  fingerprintSkillObservation, fingerprintSkillPayload, summarizeSkillEvaluation,
} from "../src/telemetry/skill-evaluation.ts"

let root = ""
let stateHome = ""
let oldStateHome: string | undefined
let oldXdgStateHome: string | undefined

beforeEach(() => {
  oldStateHome = process.env.LCA_STATE_HOME
  oldXdgStateHome = process.env.XDG_STATE_HOME
  root = mkdtempSync(join(tmpdir(), "lca-skill-observation-root-"))
  stateHome = mkdtempSync(join(tmpdir(), "lca-skill-observation-state-"))
  process.env.LCA_STATE_HOME = stateHome
  delete process.env.XDG_STATE_HOME
})

afterEach(() => {
  if (oldStateHome === undefined) delete process.env.LCA_STATE_HOME
  else process.env.LCA_STATE_HOME = oldStateHome
  if (oldXdgStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = oldXdgStateHome
  rmSync(root, { recursive: true, force: true })
  rmSync(stateHome, { recursive: true, force: true })
})

function callFact(state: "pending" | "completed" | "error" | "aborted" | "unknown" = "completed") {
  return {
    state,
    returnedContent: state === "completed" ? "observed" as const : state === "pending" ? "unknown" as const : "not_returned" as const,
    requestedName: "plan",
    returnedName: state === "completed" ? "plan" : null,
    messageID: "message_1",
    taskRelation: "unknown" as const,
  }
}

function skillOutput(body: string, directory = "/safe/project/.agents/skills/plan") {
  return [
    '<skill_content name="plan">',
    "# Skill: plan",
    "",
    body.trim(),
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    "",
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

describe("skill observation store", () => {
  test("is off until explicit activation and never initializes on a missing-store observation", () => {
    const path = skillObservationDatabasePath(root)
    expect(getSkillCampaignStatus(root).health).toBe("database_missing")
    expect(validateSkillObservationSnapshot(listSkillObservations(root))).toBe(true)
    expect(admitSkillCall(root, "canary-1", { sessionID: "session_1", callID: "call_1", stage: "before" }).code).toBe("database_missing")
    expect(existsSync(path)).toBe(false)

    const activated = activateSkillCampaign(root, "canary-1", 1_000)
    expect(activated).toMatchObject({ available: true, status: "open", sessionCount: 0, callCount: 0 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(activateSkillCampaign(root, "canary-1", 1_001).sessionCount).toBe(0)
    expect(() => activateSkillCampaign(root, "canary-2", 1_002)).toThrow("campaign_exists")
    expect(admitSkillCall(root, "canary-stale", { sessionID: "session_1", callID: "call_1", stage: "before" }, 1_002).code)
      .toBe("campaign_mismatch")
    expect(getSkillCampaignStatus(root, 1_001).campaignID).toBe("canary-1")
  })

  test("atomically admits a session and unique call, replays one key, and keeps only strict facts", () => {
    activateSkillCampaign(root, "canary-1", 1_000)
    const first = admitSkillCall(root, "canary-1", { sessionID: "session_1", callID: "call_1", stage: "before" }, 1_001)
    expect(first).toMatchObject({ admitted: true, code: "admitted" })
    if (!first.admitted) throw new Error("expected admitted call")
    expect(recordSkillCall(root, first.token, callFact("pending"), 1_002)).toMatchObject({ recorded: true, code: "recorded" })
    expect(admitSkillCall(root, "canary-1", { sessionID: "session_1", callID: "call_1", stage: "pending" }, 1_003).code).toBe("replay")
    const privateEnvelope = {
      ...callFact("error"), startedAt: 1_001, finishedAt: 1_004, durationMs: 3,
      output: "PRIVATE_SENTINEL", error: "PRIVATE_SENTINEL", args: { secret: "PRIVATE_SENTINEL" },
    }
    expect(recordSkillCall(root, first.token, privateEnvelope, 1_004)).toMatchObject({ recorded: true, code: "recorded" })
    expect(recordSkillCall(root, first.token, privateEnvelope, 1_005)).toMatchObject({ recorded: false, code: "replay" })

    const database = readFileSync(skillObservationDatabasePath(root))
    expect(database.includes(Buffer.from("PRIVATE_SENTINEL"))).toBe(false)
    expect(database.includes(Buffer.from(root))).toBe(false)
    const status = getSkillCampaignStatus(root, 1_006)
    expect(status).toMatchObject({ status: "open", sessionCount: 1, callCount: 1 })
    expect(listSkillObservations(root, { observedAt: 1_006 }).facts[0]?.payload).toMatchObject({
      state: "error", returnedContent: "not_returned", startedAt: 1_001, finishedAt: 1_004, durationMs: 3,
      loadedOriginalFileSha256: null,
    })
  })

  test("stores turn, task-attempt, and verification evidence as separate strict facts", () => {
    activateSkillCampaign(root, "canary-1", 2_000)
    expect(recordSkillTurn(root, "canary-1", {
      sessionID: "session_1", messageID: "user_msg", parentMessageID: null, phase: "terminal", role: "user",
      routerExposure: "suggest", routeDecisionID: "decision_1", routeSkillName: "plan", adviceInserted: true,
      requestEvidence: "unknown",
    }, 2_001)).toMatchObject({ recorded: true, code: "recorded" })
    const taskStarted = {
      sessionID: "session_1", taskID: "task_1", attemptID: "attempt_1", phase: "pending" as const,
      status: "started" as const, ownerSessionID: "session_1", childSessionID: "child_1", actualRole: "worker" as const,
      roleBasis: "sdk_agent_field" as const,
    }
    expect(recordSkillTask(root, "canary-1", taskStarted, 2_002)).toMatchObject({ recorded: true })
    expect(recordSkillTask(root, "canary-1", { ...taskStarted, phase: "terminal", status: "failed" }, 2_003)).toMatchObject({ recorded: true })
    const verifyStarted = {
      sessionID: "child_1", verificationID: "verify_1", taskID: "task_1", attemptID: "attempt_1",
      phase: "pending" as const, status: "started" as const, codeOwned: true,
    }
    expect(recordSkillVerification(root, "canary-1", verifyStarted, 2_004)).toMatchObject({ recorded: true })
    expect(recordSkillVerification(root, "canary-1", { ...verifyStarted, phase: "terminal", status: "fail", exitCode: 1 }, 2_005))
      .toMatchObject({ recorded: true, code: "recorded" })

    const snapshot = listSkillObservations(root, { observedAt: 2_006 })
    expect(snapshot.facts.map((fact) => fact.kind).sort()).toEqual([
      "task_context", "turn_context", "verification_observation",
    ])
    expect(snapshot.campaign.sessionCount).toBe(2)
    expect(validateSkillObservationSnapshot(snapshot)).toBe(true)
    expect(validateSkillObservationSnapshot({ ...snapshot, leakedPath: root })).toBe(false)
    expect(validateSkillObservationSnapshot({
      ...snapshot,
      facts: snapshot.facts.map((fact, index) => index === 0
        ? { ...fact, payload: { ...fact.payload, rawOutput: "PRIVATE_SENTINEL" } }
        : fact),
    })).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SENTINEL")
    expect(snapshot.coverage).toMatchObject({ populationComplete: false, unscannedTotal: "known" })
  })

  test("counts an invalid skill name without retaining its raw value", () => {
    activateSkillCampaign(root, "canary-invalid-name", 2_500)
    const admission = admitSkillCall(root, "canary-invalid-name", {
      sessionID: "session_1", callID: "call_invalid", stage: "terminal", requestedName: "../private-name",
    }, 2_501)
    expect(admission.admitted).toBe(true)
    if (!admission.admitted) throw new Error("valid call identity should be admitted")
    expect(recordSkillCall(root, admission.token, {
      state: "error", returnedContent: "not_returned", requestedName: "../private-name", requestedNameReason: "invalid_name",
    }, 2_502)).toMatchObject({ recorded: true })
    const fact = listSkillObservations(root, { observedAt: 2_503 }).facts[0]
    expect(fact?.payload).toMatchObject({ requestedName: null, requestedNameReason: "invalid_name", state: "error" })
    expect(readFileSync(skillObservationDatabasePath(root)).includes(Buffer.from("private-name"))).toBe(false)
    expect(getSkillCampaignStatus(root, 2_503).callCount).toBe(1)
  })

  test("closed campaigns refuse input and cannot be reactivated under a new id", () => {
    activateSkillCampaign(root, "canary-1", 3_000)
    for (let index = 0; index < 9; index++) {
      expect(recordSkillTurn(root, "canary-1", {
        sessionID: `session_${index}`, messageID: `message_${index}`, phase: "terminal", role: "user",
      }, 3_001 + index).recorded).toBe(true)
    }
    const tenth = recordSkillTurn(root, "canary-1", { sessionID: "session_9", messageID: "message_9", phase: "terminal", role: "user" }, 3_010)
    expect(tenth).toMatchObject({ recorded: true, code: "recorded" })
    expect(getSkillCampaignStatus(root, 3_011)).toMatchObject({ status: "closed", sessionCount: 10, stopReason: "session_limit" })
    expect(recordSkillTurn(root, "canary-1", { sessionID: "session_10", messageID: "message_10", phase: "terminal", role: "user" }, 3_012))
      .toMatchObject({ recorded: false, code: "closed" })
    expect(() => activateSkillCampaign(root, "canary-2", 3_013)).toThrow("campaign_exists")
  })

  test("best-effort observer wrapper converts arbitrary storage exceptions to a fixed health code", () => {
    expect(bestEffortSkillObservation(() => { throw new Error("PRIVATE_SENTINEL /private/path") })).toEqual({
      ok: false, health: "storage_error",
    })
  })

  test("rejects symlinked database paths and reports corrupt stores without resetting them", () => {
    activateSkillCampaign(root, "canary-1", 4_000)
    const database = skillObservationDatabasePath(root)
    const external = join(stateHome, "outside.sqlite")
    writeFileSync(external, "not a database")
    chmodSync(database, 0o600)
    rmSync(database)
    symlinkSync(external, database)
    expect(getSkillCampaignStatus(root, 4_001).health).toBe("database_corrupt")
    expect(() => activateSkillCampaign(root, "canary-1", 4_002)).toThrow("database_corrupt")
  })
})

describe("skill fingerprints", () => {
  test("separates terminal payload, supported returned body, current file, and unavailable loaded-original hashes", () => {
    const skillDir = join(root, ".agents", "skills", "plan")
    mkdirSync(skillDir, { recursive: true })
    const skillFile = join(skillDir, "SKILL.md")
    const currentFile = "---\nname: plan\ndescription: First\n---\nUse short numbered steps.\n"
    writeFileSync(skillFile, currentFile)
    const output = skillOutput("Use short numbered steps.", skillDir)
    const result = fingerprintSkillObservation({
      requestedName: "plan", returnedName: "plan", output, metadata: { name: "plan", dir: skillDir },
      renderer: SUPPORTED_SKILL_RENDERER, projectRoot: root, observedAt: 5_000,
    })
    expect(result.returnedPayloadSha256).toBe(createHash("sha256").update(output).digest("hex"))
    expect(result.returnedPayloadBasis).toBe(RETURNED_PAYLOAD_BASIS)
    expect(result.returnedBodySha256).toBe(createHash("sha256").update("Use short numbered steps.").digest("hex"))
    expect(result.returnedBodyBasis).toBe(RETURNED_BODY_BASIS)
    expect(result.observedFileSha256).toBe(createHash("sha256").update(currentFile).digest("hex"))
    expect(result.observedFileBasis).toBe(OBSERVED_FILE_BASIS)
    expect(result.returnedPayloadSha256).not.toBe(result.returnedBodySha256)
    expect(result.returnedBodySha256).not.toBe(result.observedFileSha256)
    expect(result.loadedOriginalFileSha256).toBeNull()
    expect(result.loadedOriginalFileAvailable).toBe(false)
    expect(JSON.stringify(result)).not.toContain(skillDir)

    writeFileSync(skillFile, currentFile.replace("First", "Second"))
    const frontmatterChanged = fingerprintSkillObservation({
      requestedName: "plan", returnedName: "plan", output, metadata: { name: "plan", dir: skillDir },
      renderer: SUPPORTED_SKILL_RENDERER, projectRoot: root, observedAt: 5_001,
    })
    expect(frontmatterChanged.returnedBodySha256).toBe(result.returnedBodySha256)
    expect(frontmatterChanged.observedFileSha256).not.toBe(result.observedFileSha256)
  })

  test("retains name conflicts but suppresses secret, oversized, modified, compacted, and ambiguous digests", () => {
    const output = skillOutput("Instructions", "/safe/project/.agents/skills/plan")
    const valid = {
      requestedName: "wanted", returnedName: "plan", output,
      metadata: { name: "plan", dir: "/safe/project/.agents/skills/plan" }, renderer: SUPPORTED_SKILL_RENDERER,
    }
    expect(fingerprintSkillPayload(valid)).toMatchObject({ nameConflict: true, requestedName: "wanted", returnedName: "plan" })
    expect(fingerprintSkillPayload({ ...valid, output: `${output}\napi_key: privatecredentialvalue` }))
      .toMatchObject({ returnedPayloadSha256: null, returnedBodySha256: null, payloadHashReason: "secret_detected" })
    expect(fingerprintSkillPayload({ ...valid, output: "x".repeat(1024 * 1024 + 1) }))
      .toMatchObject({ returnedPayloadSha256: null, returnedBodySha256: null, payloadHashReason: "too_large" })
    expect(fingerprintSkillPayload({ ...valid, modified: true }))
      .toMatchObject({ returnedPayloadSha256: null, returnedBodySha256: null, bodyHashReason: "modified" })
    expect(fingerprintSkillPayload({ ...valid, compacted: true }))
      .toMatchObject({ returnedPayloadSha256: expect.any(String), returnedBodySha256: null, bodyHashReason: "compacted" })
    expect(fingerprintSkillPayload({ ...valid, truncated: true }))
      .toMatchObject({ returnedBodySha256: null, bodyHashReason: "truncated" })
    expect(fingerprintSkillPayload({
      ...valid,
      output: skillOutput("Instructions\n\nBase directory for this skill: /collision"),
    })).toMatchObject({ returnedBodySha256: null, bodyHashReason: "ambiguous_boundary" })
  })

  test("hashes trimmed Unicode body bytes and treats an empty body as a valid renderer boundary", () => {
    const directory = "/safe/project/.agents/skills/plan"
    const unicodeBody = "  Unicode café\r\nsecond line\t "
    const result = fingerprintSkillPayload({
      requestedName: "plan", returnedName: "plan", output: skillOutput(unicodeBody, directory),
      metadata: { name: "plan", dir: directory }, renderer: SUPPORTED_SKILL_RENDERER,
    })
    expect(result.returnedBodySha256).toBe(createHash("sha256").update(unicodeBody.trim()).digest("hex"))
    const empty = fingerprintSkillPayload({
      requestedName: "plan", returnedName: "plan", output: skillOutput("", directory),
      metadata: { name: "plan", dir: directory }, renderer: SUPPORTED_SKILL_RENDERER,
    })
    expect(empty.returnedBodySha256).toBe(createHash("sha256").update("").digest("hex"))
  })

  test("refuses symlinked and duplicate project skill sources", () => {
    const outside = mkdtempSync(join(tmpdir(), "lca-skill-outside-"))
    const linkedParent = join(root, ".agents", "skills")
    mkdirSync(join(outside, "plan"), { recursive: true })
    writeFileSync(join(outside, "plan", "SKILL.md"), "---\nname: plan\n---\nPrivate.\n")
    mkdirSync(linkedParent, { recursive: true })
    symlinkSync(join(outside, "plan"), join(linkedParent, "plan"))
    const symlinkResult = fingerprintSkillObservation({
      requestedName: "plan", returnedName: "plan", output: skillOutput("Private.", join(linkedParent, "plan")),
      metadata: { name: "plan", dir: join(linkedParent, "plan") }, renderer: SUPPORTED_SKILL_RENDERER,
      projectRoot: root, observedAt: 6_000,
    })
    expect(symlinkResult.observedFileSha256).toBeNull()
    expect(symlinkResult.sourceHashReason).toBe("source_unsafe")

    rmSync(join(linkedParent, "plan"), { recursive: true, force: true })
    mkdirSync(join(linkedParent, "plan"), { recursive: true })
    writeFileSync(join(linkedParent, "plan", "SKILL.md"), "---\nname: plan\n---\nPrivate.\n")
    const other = join(root, ".opencode", "skills", "plan")
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, "SKILL.md"), "---\nname: plan\n---\nPrivate.\n")
    const duplicateResult = fingerprintSkillObservation({
      requestedName: "plan", returnedName: "plan", output: skillOutput("Private.", other),
      metadata: { name: "plan", dir: other }, renderer: SUPPORTED_SKILL_RENDERER, projectRoot: root, observedAt: 6_001,
    })
    expect(duplicateResult.observedFileSha256).toBeNull()
    expect(duplicateResult.sourceHashReason).toBe("source_ambiguous")
    rmSync(outside, { recursive: true, force: true })
  })
})

describe("skill evaluation summaries", () => {
  test("deduplicates unique calls without mislabeling snapshot size as the durable quota count", () => {
    const call = {
      kind: "skill_call", sessionID: "session_1", factKey: "call_1", phase: "terminal", conflict: false, recordedAt: 1,
      payload: { sessionID: "session_1", callID: "call_1", state: "completed", returnedContent: "observed",
        requestedName: "plan", returnedName: "plan", returnedBodySha256: "a".repeat(64), returnedBodyBasis: RETURNED_BODY_BASIS },
    }
    const summary = summarizeSkillEvaluation([call, call], {
      durableQuotaCalls: 100, storedFacts: 2, unscannedStoredFacts: 1, expiredFacts: 3, notCollectedAfterStop: true,
    })
    expect(summary.calls).toMatchObject({ includedUniqueCalls: 1, durableQuotaCalls: 100, completedToolCalls: 1 })
    expect(summary.coverage).toMatchObject({ acceptedFacts: 1, duplicateFacts: 1, storedFacts: 2, unscannedStoredFacts: 1, expiredFacts: 3 })
    expect(summary.fingerprints.returnedBody).toMatchObject({ numerator: 1, denominator: 1, display: "1/1" })
    expect(summarizeSkillEvaluation([]).fingerprints.returnedBody.display).toBe("N/A")
  })
})
