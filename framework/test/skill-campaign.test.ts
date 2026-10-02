import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  activateSkillCampaign, admitSkillCall, getSkillCampaignStatus, listSkillObservations, maintainSkillCampaign,
  markSkillSessionBoundary, recordSkillCall, recordSkillTask, recordSkillTurn, recordSkillVerification, skillObservationBindingHash,
  validSkillCampaignID,
  skillObservationDatabasePath, SKILL_OBSERVATION_LIMITS, stopSkillCampaign, validateSkillObservationSnapshot,
} from "../src/telemetry/skills.ts"

let root = ""
let stateHome = ""
let oldStateHome: string | undefined
let oldXdgStateHome: string | undefined

beforeEach(() => {
  oldStateHome = process.env.LCA_STATE_HOME
  oldXdgStateHome = process.env.XDG_STATE_HOME
  root = mkdtempSync(resolve(tmpdir(), "lca-skill-campaign-root-"))
  stateHome = mkdtempSync(resolve(tmpdir(), "lca-skill-campaign-state-"))
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

function terminalCall(state: "completed" | "error" = "error") {
  return { state, returnedContent: state === "completed" ? "observed" as const : "not_returned" as const }
}

function addTerminalCall(sessionID: string, callID: string, now = Date.now(), campaignID = "quota-call-cap") {
  const admission = admitSkillCall(root, campaignID, { sessionID, callID, stage: "terminal" }, now)
  if (!admission.admitted) return { admitted: false as const, code: admission.code, recorded: null }
  const recorded = recordSkillCall(root, admission.token, terminalCall(), now)
  return { admitted: true as const, code: admission.code, token: admission.token, recorded }
}

describe("campaign quota and closure", () => {
  test("the hundredth actual skill call is counted once and starts atomic draining", () => {
    activateSkillCampaign(root, "quota-call-cap", Date.now())
    for (let index = 0; index < 99; index++) {
      const result = addTerminalCall("session_1", `call_${index}`)
      expect(result.admitted).toBe(true)
      if (!result.admitted) throw new Error("expected a unique skill call slot")
      expect(result.recorded).toMatchObject({ recorded: true })
    }
    const hundredth = admitSkillCall(root, "quota-call-cap", { sessionID: "session_1", callID: "call_99", stage: "terminal" })
    expect(hundredth).toMatchObject({ admitted: true, code: "admitted" })
    if (!hundredth.admitted) throw new Error("expected terminal-only admission")
    expect(getSkillCampaignStatus(root)).toMatchObject({ status: "draining", sessionCount: 1, callCount: 100, cutoffReason: "call_limit" })
    expect(admitSkillCall(root, "quota-call-cap", { sessionID: "session_1", callID: "late_call", stage: "terminal" }).code).toBe("draining")
    expect(recordSkillCall(root, hundredth.token, terminalCall("error"))).toMatchObject({ recorded: true, code: "recorded" })
    expect(getSkillCampaignStatus(root)).toMatchObject({ status: "closed", callCount: 100, closureReason: "pending_drained" })
    const snapshot = listSkillObservations(root)
    expect(snapshot.coverage).toMatchObject({ populationComplete: false, notCollectedAfterStop: true })
    expect(snapshot.facts.filter((fact) => fact.kind === "skill_call")).toHaveLength(100)
  })

  test("the tenth actor session includes its triggering fact and admits only its exact pending key to drain", () => {
    activateSkillCampaign(root, "quota-session-cap", Date.now())
    for (let index = 0; index < 9; index++) {
      expect(recordSkillTurn(root, "quota-session-cap", {
        sessionID: `session_${index}`, messageID: `message_${index}`, phase: "terminal", role: "user",
      }).recorded).toBe(true)
    }
    const pending = admitSkillCall(root, "quota-session-cap", { sessionID: "child_10", callID: "call_10", stage: "before" })
    expect(pending).toMatchObject({ admitted: true, code: "admitted" })
    if (!pending.admitted) throw new Error("expected the tenth actor session")
    const cutoff = getSkillCampaignStatus(root)
    expect(cutoff).toMatchObject({ status: "draining", sessionCount: 10, callCount: 1, cutoffReason: "session_limit", pendingCount: 1 })
    expect(admitSkillCall(root, "quota-session-cap", { sessionID: "child_10", callID: "new_call", stage: "terminal" }).code).toBe("draining")
    expect(recordSkillCall(root, pending.token, terminalCall("completed"))).toMatchObject({ recorded: true })
    expect(getSkillCampaignStatus(root)).toMatchObject({ status: "closed", sessionCount: 10, closureReason: "pending_drained" })
  })

  test("persisted drain deadline is not reset across status reads or a late restart", async () => {
    const startedAt = Date.now()
    activateSkillCampaign(root, "deadline-canary", startedAt)
    for (let index = 0; index < 9; index++) {
      recordSkillTurn(root, "deadline-canary", { sessionID: `session_${index}`, messageID: `message_${index}`, phase: "terminal", role: "user" }, startedAt + index + 1)
    }
    const admission = admitSkillCall(root, "deadline-canary", { sessionID: "session_10", callID: "pending_call", stage: "before" }, startedAt + 10)
    if (!admission.admitted) throw new Error("expected call admission")
    const deadline = getSkillCampaignStatus(root, startedAt + 10).drainDeadline
    expect(deadline).toBe(startedAt + 10 + 5 * 60 * 1000)
    expect(getSkillCampaignStatus(root, startedAt + 60_000).drainDeadline).toBe(deadline)
    const cli = resolve(import.meta.dir, "../../scripts/lca-skill-observation.ts")
    const restarted = Bun.spawn([process.execPath, cli, "status", "--root", root, "--campaign-id", "deadline-canary"], {
      env: { ...process.env, LCA_STATE_HOME: stateHome }, stdout: "pipe", stderr: "pipe",
    })
    const [restartedOutput, restartedExit] = await Promise.all([
      new Response(restarted.stdout).text(), restarted.exited,
    ])
    expect(restartedExit).toBe(0)
    expect(JSON.parse(restartedOutput).drainDeadline).toBe(deadline)
    expect(recordSkillCall(root, admission.token, terminalCall("completed"), deadline!)).toMatchObject({ recorded: false, code: "closed" })
    expect(getSkillCampaignStatus(root, deadline! + 1)).toMatchObject({
      status: "closed", drainDeadline: deadline, closureReason: "quota_deadline", pendingCount: 0, censoredCount: 1,
    })
  })

  test("manual stop is immediate, observer-only, and leaves quota tombstone after raw TTL", () => {
    const startedAt = Date.now()
    activateSkillCampaign(root, "stop-canary", startedAt)
    const admission = admitSkillCall(root, "stop-canary", { sessionID: "session_1", callID: "pending_call", stage: "before" }, startedAt + 1)
    if (!admission.admitted) throw new Error("expected call admission")
    const stopped = stopSkillCampaign(root, "stop-canary", startedAt + 2)
    expect(stopped).toMatchObject({ status: "closed", stopReason: "manual_stop", closureReason: "manual_stop", callCount: 1 })
    expect(recordSkillCall(root, admission.token, terminalCall("completed"), startedAt + 3)).toMatchObject({ recorded: false, code: "closed" })
    const afterTTL = listSkillObservations(root, { observedAt: startedAt + 31 * 24 * 60 * 60 * 1000 })
    expect(afterTTL.facts).toEqual([])
    expect(afterTTL.campaign).toMatchObject({ status: "closed", sessionCount: 1, callCount: 1, stopReason: "manual_stop", censoredCount: 1 })
    expect(existsDatabase()).toBe(true)
    expect(() => activateSkillCampaign(root, "stop-canary-2", startedAt + 31 * 24 * 60 * 60 * 1000)).toThrow("campaign_exists")
  })

  test("backward clock closes the persisted campaign rather than extending a deadline", () => {
    activateSkillCampaign(root, "clock-canary", 50_000)
    expect(recordSkillTurn(root, "clock-canary", { sessionID: "session_1", messageID: "message_1", phase: "terminal", role: "user" }, 50_001).recorded).toBe(true)
    const result = recordSkillTurn(root, "clock-canary", { sessionID: "session_1", messageID: "message_2", phase: "terminal", role: "user" }, 49_999)
    expect(result).toMatchObject({ recorded: false, code: "closed" })
    expect(getSkillCampaignStatus(root, 50_002)).toMatchObject({ status: "closed", stopReason: "clock_uncertain" })
  })

  test("a delayed default-clock writer samples after acquiring the ledger lock", async () => {
    const activatedAt = Date.now()
    activateSkillCampaign(root, "clock-order-canary", activatedAt)
    const sampledPath = join(stateHome, "clock-sampled")
    const releasePath = join(stateHome, "clock-release")
    const moduleURL = new URL("../src/telemetry/skills.ts", import.meta.url).href
    const program = `
      import { existsSync, writeFileSync } from "node:fs";
      import { admitSkillCall, getSkillCampaignStatus } from ${JSON.stringify(moduleURL)};
      const realNow = Date.now.bind(Date);
      let first = true;
      Date.now = () => {
        const sampledAt = realNow();
        if (first) {
          first = false;
          writeFileSync(process.env.LCA_TEST_SAMPLED, String(sampledAt));
          const wait = new Int32Array(new SharedArrayBuffer(4));
          const deadline = realNow() + 5000;
          while (!existsSync(process.env.LCA_TEST_RELEASE) && realNow() < deadline) Atomics.wait(wait, 0, 0, 1);
        }
        return sampledAt;
      };
      const admission = admitSkillCall(process.env.LCA_TEST_ROOT, "clock-order-canary", {
        sessionID: "older_writer", callID: "older_call", stage: "before",
      });
      console.log(JSON.stringify({ admission, status: getSkillCampaignStatus(process.env.LCA_TEST_ROOT) }));
    `
    const child = Bun.spawn([process.execPath, "-e", program], {
      env: {
        ...process.env, LCA_STATE_HOME: stateHome, LCA_TEST_ROOT: root,
        LCA_TEST_SAMPLED: sampledPath, LCA_TEST_RELEASE: releasePath,
      },
      stdout: "pipe", stderr: "pipe",
    })
    const outputPromise = new Response(child.stdout).text()
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 10_000
    while (!existsSync(sampledPath) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 1)
    let sampleObserved = false
    let competingWriter: ReturnType<typeof admitSkillCall> | undefined
    try {
      sampleObserved = existsSync(sampledPath)
      if (sampleObserved) {
        competingWriter = admitSkillCall(root, "clock-order-canary", {
          sessionID: "newer_writer", callID: "newer_call", stage: "before",
        })
      }
    } finally {
      writeFileSync(releasePath, "release")
    }
    const [output, exitCode] = await Promise.all([outputPromise, child.exited])
    expect(sampleObserved).toBe(true)
    expect(competingWriter).toMatchObject({ admitted: false, code: "busy" })
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ admission: { admitted: true, code: "admitted" }, status: { status: "open" } })
    expect(admitSkillCall(root, "clock-order-canary", {
      sessionID: "newer_writer", callID: "newer_call", stage: "before",
    })).toMatchObject({ admitted: true, code: "admitted" })
    expect(getSkillCampaignStatus(root)).toMatchObject({ status: "open", sessionCount: 2, callCount: 2 })
  })

  test("the exported campaign validator retains the complete core identifier grammar", () => {
    expect(validSkillCampaignID("Campaign.alpha_beta-2:rev3")).toBe(true)
    expect(validSkillCampaignID("UPPERCASE")).toBe(true)
    expect(validSkillCampaignID("")).toBe(false)
    expect(validSkillCampaignID(".leading-dot")).toBe(false)
    expect(validSkillCampaignID("path/segment")).toBe(false)
    expect(validSkillCampaignID("x".repeat(101))).toBe(false)
  })

  test("malformed and preactivation admissions produce only saturating fixed counters", () => {
    const activatedAt = 50_000
    activateSkillCampaign(root, "rejection-canary", activatedAt)
    expect(admitSkillCall(root, "rejection-canary", { sessionID: "bad//session", callID: "call_1", stage: "before" }, activatedAt + 1))
      .toMatchObject({ admitted: false, code: "invalid_identifier" })
    expect(admitSkillCall(root, "rejection-canary", { sessionID: "session_1", callID: "call_2", stage: "unknown" as never }, activatedAt + 2))
      .toMatchObject({ admitted: false, code: "invalid_fact" })
    expect(admitSkillCall(root, "rejection-canary", {
      sessionID: "old_session", callID: "old_call", stage: "terminal", finishedAt: activatedAt - 1,
    }, activatedAt + 3)).toMatchObject({ admitted: false, code: "preactivation" })
    const status = getSkillCampaignStatus(root, activatedAt + 4)
    expect(status).toMatchObject({
      sessionCount: 0, callCount: 0,
      rejections: { invalid_identifier: 1, invalid_fact: 1, preactivation: 1 },
    })
    expect(JSON.stringify(status)).not.toContain("bad//session")
    expect(validateSkillObservationSnapshot(listSkillObservations(root, { observedAt: activatedAt + 4 }))).toBe(true)

    const db = new Database(skillObservationDatabasePath(root))
    db.query("UPDATE campaigns SET rejected_invalid_identifier = ? WHERE singleton = 1")
      .run(SKILL_OBSERVATION_LIMITS.rejectionCount)
    db.close()
    admitSkillCall(root, "rejection-canary", { sessionID: "bad//again", callID: "call_3", stage: "before" }, activatedAt + 5)
    expect(getSkillCampaignStatus(root, activatedAt + 6).rejections.invalid_identifier)
      .toBe(SKILL_OBSERVATION_LIMITS.rejectionCount)

    stopSkillCampaign(root, "rejection-canary", activatedAt + 7)
    const closedCounts = getSkillCampaignStatus(root, activatedAt + 8).rejections
    admitSkillCall(root, "rejection-canary", { sessionID: "bad//after", callID: "call_4", stage: "before" }, activatedAt + 9)
    expect(getSkillCampaignStatus(root, activatedAt + 10).rejections).toEqual(closedCounts)
  })

  test("owner binding pins same-ID replay and refuses copied, moved, or missing state", () => {
    const campaignID = "binding-canary"
    const firstBinding = skillObservationBindingHash(root)
    expect(firstBinding).toMatch(/^[a-f0-9]{64}$/)
    activateSkillCampaign(root, campaignID)
    const admission = admitSkillCall(root, campaignID, { sessionID: "binding_session", callID: "binding_call", stage: "before" })
    expect(admission.admitted).toBe(true)
    writeProjectCampaignConfig(campaignID, firstBinding)
    expect(activateSkillCampaign(root, campaignID)).toMatchObject({ callCount: 1, ownerBinding: firstBinding })
    expect(() => activateSkillCampaign(root, "different-campaign")).toThrow("campaign_exists")

    const movedState = mkdtempSync(resolve(tmpdir(), "lca-skill-campaign-moved-state-"))
    const selectedState = process.env.LCA_STATE_HOME
    try {
      process.env.LCA_STATE_HOME = movedState
      expect(skillObservationBindingHash(root)).not.toBe(firstBinding)
      expect(() => activateSkillCampaign(root, campaignID)).toThrow("binding_mismatch")
      expect(existsSync(skillObservationDatabasePath(root))).toBe(false)
    } finally {
      if (selectedState === undefined) delete process.env.LCA_STATE_HOME
      else process.env.LCA_STATE_HOME = selectedState
      rmSync(movedState, { recursive: true, force: true })
    }

    const copiedRoot = mkdtempSync(resolve(tmpdir(), "lca-skill-campaign-copied-root-"))
    try {
      const copiedDatabase = skillObservationDatabasePath(copiedRoot)
      mkdirSync(dirname(copiedDatabase), { recursive: true, mode: 0o700 })
      copyFileSync(skillObservationDatabasePath(root), copiedDatabase)
      expect(getSkillCampaignStatus(copiedRoot).health).toBe("binding_mismatch")
      expect(() => activateSkillCampaign(copiedRoot, campaignID)).toThrow("binding_mismatch")
    } finally {
      rmSync(copiedRoot, { recursive: true, force: true })
    }

    const missingRoot = mkdtempSync(resolve(tmpdir(), "lca-skill-campaign-missing-db-"))
    try {
      writeProjectCampaignConfig(campaignID, skillObservationBindingHash(missingRoot), missingRoot)
      expect(() => activateSkillCampaign(missingRoot, campaignID)).toThrow("database_missing")
      expect(existsSync(skillObservationDatabasePath(missingRoot))).toBe(false)
    } finally {
      rmSync(missingRoot, { recursive: true, force: true })
    }
  })

  test("activation refuses an unsafe project config without following it or exposing its contents", () => {
    const directory = join(root, ".lca")
    mkdirSync(directory)
    const configPath = join(directory, "lca.jsonc")
    writeFileSync(configPath, "x".repeat(SKILL_OBSERVATION_LIMITS.maxConfigBytes + 1))
    expect(() => activateSkillCampaign(root, "oversize-config")).toThrow("binding_mismatch")
    rmSync(configPath)
    writeFileSync(configPath, "{ broken private sentinel }")
    expect(() => activateSkillCampaign(root, "broken-config")).toThrow("binding_mismatch")
    rmSync(configPath)
    const externalConfig = join(stateHome, "private-config")
    writeFileSync(externalConfig, JSON.stringify({ skill_observation: {
      enabled: true, campaign_id: "symlink-config", owner_binding: skillObservationBindingHash(root),
    } }))
    symlinkSync(externalConfig, configPath)
    expect(() => activateSkillCampaign(root, "symlink-config")).toThrow("binding_mismatch")
    expect(existsSync(skillObservationDatabasePath(root))).toBe(false)
  })

  test("task attempt failure remains separate from final task status and review outcomes", () => {
    activateSkillCampaign(root, "task-status-canary")
    const attempt = {
      sessionID: "task_session", taskID: "task_one", attemptID: "attempt_one", phase: "terminal" as const,
      status: "failed" as const, taskStatus: "open" as const, childSessionID: "child_session",
      childMessageID: "child_user_message", resumeRequested: false,
    }
    expect(recordSkillTask(root, "task-status-canary", attempt)).toMatchObject({ recorded: true })
    expect(recordSkillTask(root, "task-status-canary", { ...attempt, taskStatus: "done" })).toMatchObject({ recorded: true, code: "recorded" })
    expect(recordSkillTask(root, "task-status-canary", { ...attempt, taskStatus: "failed" })).toMatchObject({ recorded: true, code: "conflict" })
    expect(recordSkillVerification(root, "task-status-canary", {
      sessionID: "task_session", verificationID: "review_one", taskID: "task_one", attemptID: "attempt_one",
      phase: "terminal", status: "not_run", codeOwned: true, reviewVerdict: "skipped",
    })).toMatchObject({ recorded: true })
    expect(recordSkillVerification(root, "task-status-canary", {
      sessionID: "task_session", verificationID: "review_two", taskID: "task_one", attemptID: "attempt_one",
      phase: "terminal", status: "not_run", codeOwned: true, reviewVerdict: "error",
    })).toMatchObject({ recorded: true })
    const snapshot = listSkillObservations(root)
    const task = snapshot.facts.find((fact) => fact.kind === "task_context")
    expect(task).toMatchObject({ conflict: true, payload: { status: "failed", taskStatus: "done", childMessageID: "child_user_message", resumeRequested: false } })
    expect(validateSkillObservationSnapshot(snapshot)).toBe(true)
  })

  test("turn terminal preactivation timing and private model paths are rejected before admission", () => {
    const activatedAt = 50_000
    activateSkillCampaign(root, "turn-time-canary", activatedAt)
    expect(recordSkillTurn(root, "turn-time-canary", {
      sessionID: "old_turn_session", messageID: "old_message", phase: "terminal", role: "assistant",
      finishedAt: activatedAt - 1,
    }, activatedAt + 1)).toMatchObject({ recorded: false, code: "preactivation" })
    expect(recordSkillTurn(root, "turn-time-canary", {
      sessionID: "private_model_session", messageID: "private_model_message", phase: "terminal", role: "assistant",
      actualModel: "provider:/Users/private-personal-path/model",
    }, activatedAt + 2)).toMatchObject({ recorded: false, code: "invalid_fact" })
    expect(recordSkillTurn(root, "turn-time-canary", {
      sessionID: "double_slash_session", messageID: "double_slash_message", phase: "terminal", role: "assistant",
      actualModel: "provider//private/model",
    }, activatedAt + 3)).toMatchObject({ recorded: false, code: "invalid_fact" })
    expect(recordSkillTurn(root, "turn-time-canary", {
      sessionID: "drive_path_session", messageID: "drive_path_message", phase: "terminal", role: "assistant",
      actualModel: "provider/C:/Users/private/model",
    }, activatedAt + 4)).toMatchObject({ recorded: false, code: "invalid_fact" })
    expect(getSkillCampaignStatus(root, activatedAt + 3)).toMatchObject({
      sessionCount: 0, rejections: { preactivation: 1 },
    })
    const observations = JSON.stringify(listSkillObservations(root, { observedAt: activatedAt + 5 }))
    expect(observations).not.toContain("private-personal-path")
    expect(observations).not.toContain("provider//private/model")
    expect(observations).not.toContain("provider/C:/Users/private/model")
  })

  test("stop and bounded TTL cleanup preserve unresolved tombstone counts", () => {
    const activatedAt = Date.now()
    activateSkillCampaign(root, "censored-canary", activatedAt)
    for (let index = 0; index < 125; index++) {
      expect(recordSkillTurn(root, "censored-canary", {
        sessionID: "session_1", messageID: `pending_${index}`, phase: "pending", role: "assistant",
      }, activatedAt + index + 1).recorded).toBe(true)
    }
    expect(getSkillCampaignStatus(root, activatedAt + 200)).toMatchObject({ pendingCount: 125 })
    const pendingSnapshot = listSkillObservations(root, { observedAt: activatedAt + 201 })
    expect(validateSkillObservationSnapshot(pendingSnapshot)).toBe(true)
    const excessivePending = structuredClone(pendingSnapshot)
    excessivePending.campaign.pendingCount = SKILL_OBSERVATION_LIMITS.facts + 1
    expect(validateSkillObservationSnapshot(excessivePending)).toBe(false)
    const withPrivateField = structuredClone(pendingSnapshot) as typeof pendingSnapshot & { campaign: Record<string, unknown> }
    withPrivateField.campaign.rawBody = "PRIVATE_RAW_BODY_SENTINEL"
    expect(validateSkillObservationSnapshot(withPrivateField)).toBe(false)
    const stopped = stopSkillCampaign(root, "censored-canary", activatedAt + 202)
    expect(stopped).toMatchObject({ status: "closed", pendingCount: 0, censoredCount: 125 })
    const early = listSkillObservations(root, { observedAt: activatedAt + SKILL_OBSERVATION_LIMITS.retentionMs + 2 })
    expect(early.facts.length).toBeGreaterThan(0)
    const maintained = maintainSkillCampaign(root, "censored-canary", activatedAt + SKILL_OBSERVATION_LIMITS.retentionMs + 203)
    expect(maintained).toMatchObject({ status: "closed", censoredCount: 125, sessionCount: 1 })
    const cleaned = listSkillObservations(root, { observedAt: activatedAt + SKILL_OBSERVATION_LIMITS.retentionMs + 204 })
    expect(cleaned.facts).toEqual([])
    expect(cleaned.campaign).toMatchObject({ status: "closed", pendingCount: 0, censoredCount: 125, sessionCount: 1 })
    expect(validateSkillObservationSnapshot(cleaned)).toBe(true)
  })

  test("1,000-event fixture exercises the representative recorder and bounded export path", () => {
    const activatedAt = Date.now()
    activateSkillCampaign(root, "recorder-fixture", activatedAt)
    for (let index = 0; index < 1_000; index++) {
      expect(recordSkillTurn(root, "recorder-fixture", {
        sessionID: "fixture_session", messageID: `fixture_message_${index}`, phase: "terminal", role: "assistant",
      }, activatedAt + index + 1).recorded).toBe(true)
    }
    const snapshot = listSkillObservations(root, { limit: 1_000, observedAt: activatedAt + 1_001 })
    expect(snapshot.facts).toHaveLength(1_000)
    expect(validateSkillObservationSnapshot(snapshot)).toBe(true)
  })

  test("pending relation work is capped at 1,024 amid the full 50,000-row store", () => {
    const activatedAt = Date.now()
    activateSkillCampaign(root, "relation-cap-fixture", activatedAt)
    seedLargeLedger(SKILL_OBSERVATION_LIMITS.maxPendingRelations + 6, SKILL_OBSERVATION_LIMITS.facts)
    const before = listSkillObservations(root, { limit: 20, observedAt: activatedAt + 1 })
    expect(before.campaign.pendingCount).toBe(SKILL_OBSERVATION_LIMITS.maxPendingRelations + 6)
    expect(before.campaign.storedFactCount).toBe(SKILL_OBSERVATION_LIMITS.facts - 2)
    expect(validateSkillObservationSnapshot(before)).toBe(true)

    expect(markSkillSessionBoundary(
      root, "relation-cap-fixture", "bounded_relation_session", "deleted", activatedAt + 2,
    )).toMatchObject({ recorded: true, code: "recorded" })
    expect(getSkillCampaignStatus(root, activatedAt + 3).pendingCount).toBe(6)
    expect(markSkillSessionBoundary(
      root, "relation-cap-fixture", "bounded_relation_session", "deleted", activatedAt + 4,
    )).toMatchObject({ recorded: true, code: "recorded" })
    expect(getSkillCampaignStatus(root, activatedAt + 5).pendingCount).toBe(0)
  })

  test("busy storage loses no fabricated admissions; corrupt and full stores fail closed without reset", () => {
    activateSkillCampaign(root, "resource-health-canary")
    const path = skillObservationDatabasePath(root)
    const lock = new Database(path)
    lock.exec("BEGIN IMMEDIATE")
    try {
      expect(admitSkillCall(root, "resource-health-canary", {
        sessionID: "busy_session", callID: "busy_call", stage: "before",
      })).toMatchObject({ admitted: false, code: "busy" })
    } finally {
      lock.exec("ROLLBACK")
      lock.close()
    }
    expect(getSkillCampaignStatus(root)).toMatchObject({ sessionCount: 0, callCount: 0, rejections: {
      invalid_identifier: 0, invalid_fact: 0, preactivation: 0,
    } })
    seedLargeLedger(1, SKILL_OBSERVATION_LIMITS.facts)
    expect(admitSkillCall(root, "resource-health-canary", {
      sessionID: "bounded_relation_session", callID: "full_call", stage: "before",
    })).toMatchObject({ admitted: false, code: "resource_cap" })
    const fullStatus = getSkillCampaignStatus(root)
    expect(fullStatus).toMatchObject({ status: "closed", stopReason: "resource_cap", censoredCount: 1 })
    expect(activateSkillCampaign(root, "resource-health-canary")).toMatchObject({
      status: "closed", stopReason: "resource_cap", censoredCount: 1, sessionCount: 1, callCount: 0,
    })
    admitSkillCall(root, "resource-health-canary", { sessionID: "bad//after-full", callID: "call_x", stage: "before" })
    expect(getSkillCampaignStatus(root).rejections.invalid_identifier).toBe(0)

    const corruptRoot = mkdtempSync(resolve(tmpdir(), "lca-skill-campaign-corrupt-"))
    try {
      activateSkillCampaign(corruptRoot, "corrupt-canary")
      const corruptPath = skillObservationDatabasePath(corruptRoot)
      writeFileSync(corruptPath, "not a sqlite store")
      chmodSync(corruptPath, 0o600)
      expect(getSkillCampaignStatus(corruptRoot).health).toBe("database_corrupt")
      expect(() => activateSkillCampaign(corruptRoot, "corrupt-canary")).toThrow("database_corrupt")
    } finally {
      rmSync(corruptRoot, { recursive: true, force: true })
    }
  })

  test("child admission abort before commit rolls back, while committed pending admission survives process exit", async () => {
    activateSkillCampaign(root, "child-commit-canary")
    const path = skillObservationDatabasePath(root)
    const db = new Database(path)
    db.exec(`CREATE TRIGGER abort_call_before_commit BEFORE INSERT ON call_keys BEGIN SELECT RAISE(ABORT, 'fixture_abort'); END`)
    const moduleURL = new URL("../src/telemetry/skills.ts", import.meta.url).href
    const program = `
      import { admitSkillCall } from ${JSON.stringify(moduleURL)};
      const result = admitSkillCall(process.env.LCA_TEST_ROOT, "child-commit-canary", {
        sessionID: "child_session", callID: process.env.LCA_TEST_CALL, stage: "before",
      });
      console.log(JSON.stringify(result));
    `
    const runChild = async (callID: string) => {
      const child = Bun.spawn([process.execPath, "-e", program], {
        env: { ...process.env, LCA_STATE_HOME: stateHome, LCA_TEST_ROOT: root, LCA_TEST_CALL: callID },
        stdout: "pipe", stderr: "pipe",
      })
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
      return { stdout, exitCode }
    }
    try {
      const aborted = await runChild("aborted_call")
      expect(aborted.exitCode).toBe(0)
      expect(JSON.parse(aborted.stdout)).toMatchObject({ admitted: false, code: "storage_error" })
      expect(getSkillCampaignStatus(root)).toMatchObject({ sessionCount: 0, callCount: 0 })
      expect(db.query("SELECT next_sequence FROM campaigns WHERE singleton = 1").get()).toMatchObject({ next_sequence: 0 })
      db.exec("DROP TRIGGER abort_call_before_commit")
      const committed = await runChild("committed_call")
      expect(committed.exitCode).toBe(0)
      expect(JSON.parse(committed.stdout)).toMatchObject({ admitted: true, code: "admitted" })
      expect(getSkillCampaignStatus(root)).toMatchObject({ sessionCount: 1, callCount: 1, pendingCount: 1 })
      expect(db.query("SELECT next_sequence FROM campaigns WHERE singleton = 1").get()).toMatchObject({ next_sequence: 1 })
    } finally {
      db.close()
    }
  })

  test("terminal replay retains its first current-file observation and hashes only returned evidence", () => {
    const activatedAt = Date.now()
    activateSkillCampaign(root, "replay-fingerprint", activatedAt)
    const admission = admitSkillCall(root, "replay-fingerprint", {
      sessionID: "replay_session", callID: "replay_call", stage: "terminal", finishedAt: activatedAt + 1,
    }, activatedAt + 1)
    if (!admission.admitted) throw new Error("expected first terminal-only admission")
    const fileDigest = "a".repeat(64)
    const first = recordSkillCall(root, admission.token, {
      state: "completed", returnedContent: "observed", returnedName: "skill-one",
      returnedPayloadSha256: "b".repeat(64), returnedPayloadBasis: "terminal-output-utf8.v1",
      observedFileSha256: fileDigest, observedFileBasis: "current-project-skill-file-at-observation.v1",
      observedFileSize: 50, observedFileAt: activatedAt + 1,
    }, activatedAt + 2)
    expect(first).toMatchObject({ recorded: true, code: "recorded" })
    const replay = recordSkillCall(root, admission.token, {
      state: "completed", returnedContent: "observed", returnedName: "skill-one",
      returnedPayloadSha256: "b".repeat(64), returnedPayloadBasis: "terminal-output-utf8.v1",
      observedFileSha256: "c".repeat(64), observedFileBasis: "current-project-skill-file-at-observation.v1",
      observedFileSize: 51, observedFileAt: activatedAt + 10,
    }, activatedAt + 10)
    expect(replay).toMatchObject({ recorded: false, code: "replay" })
    const fact = listSkillObservations(root, { observedAt: activatedAt + 11 }).facts[0]
    expect(fact?.payload).toMatchObject({
      returnedPayloadSha256: "b".repeat(64), observedFileSha256: fileDigest,
      observedFileSize: 50, observedFileAt: activatedAt + 1, conflict: false,
    })
    expect(validateSkillObservationSnapshot(listSkillObservations(root, { observedAt: activatedAt + 11 }))).toBe(true)
    expect(recordSkillCall(root, admission.token, {
      state: "error", returnedContent: "not_returned", returnedName: "different-skill",
      returnedPayloadSha256: "d".repeat(64), returnedPayloadBasis: "terminal-output-utf8.v1",
    }, activatedAt + 12)).toMatchObject({ recorded: true, code: "conflict" })
    expect(listSkillObservations(root, { observedAt: activatedAt + 13 }).facts[0]).toMatchObject({ phase: "conflict", conflict: true })
  })

  test("secret or oversized terminal observations suppress all hashes even after pending enrichment", () => {
    const activatedAt = Date.now()
    activateSkillCampaign(root, "secret-suppression", activatedAt)
    const admission = admitSkillCall(root, "secret-suppression", { sessionID: "secret_session", callID: "secret_call", stage: "before" }, activatedAt + 1)
    if (!admission.admitted) throw new Error("expected call admission")
    recordSkillCall(root, admission.token, {
      state: "pending", returnedContent: "unknown",
      returnedPayloadSha256: "b".repeat(64), returnedPayloadBasis: "terminal-output-utf8.v1",
      returnedBodySha256: "c".repeat(64), returnedBodyBasis: "opencode-1.18.33.trimmed-content.v1",
      observedFileSha256: "d".repeat(64), observedFileBasis: "current-project-skill-file-at-observation.v1",
      observedFileSize: 50, observedFileAt: activatedAt + 1,
    }, activatedAt + 1)
    const result = recordSkillCall(root, admission.token, {
      state: "completed", returnedContent: "observed", payloadHashReason: "secret_detected",
      returnedPayloadSha256: "e".repeat(64), returnedPayloadBasis: "terminal-output-utf8.v1",
      returnedBodySha256: "f".repeat(64), returnedBodyBasis: "opencode-1.18.33.trimmed-content.v1",
      observedFileSha256: "a".repeat(64), observedFileBasis: "current-project-skill-file-at-observation.v1",
      observedFileSize: 50, observedFileAt: activatedAt + 2,
    }, activatedAt + 2)
    expect(result.recorded).toBe(true)
    const fact = listSkillObservations(root, { observedAt: activatedAt + 3 }).facts[0]
    expect(fact?.payload).toMatchObject({
      returnedPayloadSha256: null, returnedPayloadBasis: null, payloadHashReason: "secret_detected",
      returnedBodySha256: null, returnedBodyBasis: null, bodyHashReason: "secret_detected",
      observedFileSha256: null, observedFileBasis: null, observedFileReason: "secret_detected",
      observedFileSize: null, observedFileAt: null,
    })
    const largeAdmission = admitSkillCall(root, "secret-suppression", {
      sessionID: "large_session", callID: "large_call", stage: "before",
    }, activatedAt + 4)
    if (!largeAdmission.admitted) throw new Error("expected oversized call admission")
    recordSkillCall(root, largeAdmission.token, {
      state: "completed", returnedContent: "observed", bodyHashReason: "too_large",
      returnedPayloadSha256: "1".repeat(64), returnedPayloadBasis: "terminal-output-utf8.v1",
      returnedBodySha256: "2".repeat(64), returnedBodyBasis: "opencode-1.18.33.trimmed-content.v1",
      observedFileSha256: "3".repeat(64), observedFileBasis: "current-project-skill-file-at-observation.v1",
      observedFileSize: 50, observedFileAt: activatedAt + 4,
    }, activatedAt + 5)
    const largeFact = listSkillObservations(root, { observedAt: activatedAt + 6 }).facts.find((candidate) => candidate.factKey === "large_call")
    expect(largeFact?.payload).toMatchObject({
      returnedPayloadSha256: null, payloadHashReason: "too_large",
      returnedBodySha256: null, bodyHashReason: "too_large",
      observedFileSha256: null, observedFileReason: "too_large",
    })
    expect(validateSkillObservationSnapshot(listSkillObservations(root, { observedAt: activatedAt + 6 }))).toBe(true)
  })

  test("the CLI requires explicit activate root/id and emits only safe campaign records", async () => {
    const script = resolve(import.meta.dir, "../../scripts/lca-skill-observation.ts")
    const run = async (...args: string[]) => {
      const processHandle = Bun.spawn([process.execPath, script, ...args], {
        env: { ...process.env, LCA_STATE_HOME: stateHome },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(), processHandle.exited,
      ])
      return { stdout, stderr, exitCode }
    }
    expect((await run("activate", "--root", root)).exitCode).toBe(2)
    const activated = await run("activate", "--root", root, "--campaign-id", "cli-canary")
    expect(activated.exitCode).toBe(0)
    expect(activated.stdout).toContain('"campaignID": "cli-canary"')
    expect(activated.stdout).not.toContain(root)
    const activationStatus = JSON.parse(activated.stdout)
    expect(activationStatus.ownerBinding).toMatch(/^[a-f0-9]{64}$/)
    expect(activationStatus.rejections).toEqual({ invalid_identifier: 0, invalid_fact: 0, preactivation: 0 })
    const status = await run("status", "--root", root)
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain('"status": "open"')
    expect(JSON.parse(status.stdout).ownerBinding).toBe(activationStatus.ownerBinding)
    expect((await run("stop", "--root", root, "--campaign-id", "cli-canary")).stdout).toContain('"stopReason": "manual_stop"')
    expect((await run("activate", "--root", root, "--campaign-id", "second-canary")).exitCode).toBe(1)
  })
})

describe("concurrent quota admission", () => {
  test("multi-process session+call admission at 9/99 is atomic and never exceeds either limit", async () => {
    const startedAt = Date.now()
    activateSkillCampaign(root, "concurrent-canary", startedAt)
    for (let index = 0; index < 9; index++) {
      expect(recordSkillTurn(root, "concurrent-canary", {
        sessionID: `seed_session_${index}`, messageID: `seed_message_${index}`, phase: "terminal", role: "user",
      }, Date.now()).recorded).toBe(true)
    }
    for (let index = 0; index < 99; index++) {
      const result = addTerminalCall("seed_session_0", `seed_call_${index}`, Date.now(), "concurrent-canary")
      expect(result.admitted).toBe(true)
    }

    const moduleURL = new URL("../src/telemetry/skills.ts", import.meta.url).href
    const program = `
      import { admitSkillCall, recordSkillCall } from ${JSON.stringify(moduleURL)};
      const sessionID = process.env.LCA_TEST_SESSION;
      const callID = process.env.LCA_TEST_CALL;
      const admission = admitSkillCall(process.env.LCA_TEST_ROOT, "concurrent-canary", { sessionID, callID, stage: "terminal" });
      const record = admission.admitted
        ? recordSkillCall(process.env.LCA_TEST_ROOT, admission.token, { state: "error", returnedContent: "not_returned" })
        : null;
      console.log(JSON.stringify({ admitted: admission.admitted, code: admission.code, record }));
    `
    const children = Array.from({ length: 12 }, (_, index) => Bun.spawn([process.execPath, "-e", program], {
      env: {
        ...process.env,
        LCA_STATE_HOME: stateHome,
        LCA_TEST_ROOT: root,
        LCA_TEST_SESSION: `racing_session_${index}`,
        LCA_TEST_CALL: `racing_call_${index}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }))
    const results = await Promise.all(children.map(async (child, index) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      return { stdout, stderr, exitCode, index }
    }))
    for (const result of results) expect(result.exitCode).toBe(0)
    const decoded = results.map((result) => ({ ...result, value: JSON.parse(result.stdout) }))
    const admitted = decoded.filter((result) => result.value.admitted)
    if (admitted.length === 0) {
      const retry = admitSkillCall(root, "concurrent-canary", {
        sessionID: "racing_retry_session", callID: "racing_retry_call", stage: "terminal",
      })
      expect(retry.admitted).toBe(true)
      if (retry.admitted) recordSkillCall(root, retry.token, terminalCall())
    }
    let status = getSkillCampaignStatus(root)
    if (status.status === "draining") {
      const admittedIndex = admitted[0]!.index
      const sessionID = `racing_session_${admittedIndex}`
      const callID = `racing_call_${admittedIndex}`
      const closure = admitSkillCall(root, "concurrent-canary", { sessionID, callID, stage: "terminal" })
      if (closure.admitted) recordSkillCall(root, closure.token, terminalCall())
      status = getSkillCampaignStatus(root)
    }
    expect(status.sessionCount).toBeLessThanOrEqual(10)
    expect(status.callCount).toBeLessThanOrEqual(100)
    expect(status.sessionCount).toBe(10)
    expect(status.callCount).toBe(100)
    expect(status.status).toBe("closed")
    expect(listSkillObservations(root).facts.filter((fact) => fact.kind === "skill_call")).toHaveLength(100)
    expect(JSON.stringify(results)).not.toContain(root)
  })
})

function existsDatabase(): boolean {
  return existsSync(skillObservationDatabasePath(root))
}

function turnPayload(sessionID: string, messageID: string, phase: "pending" | "terminal") {
  return {
    schemaVersion: 1, sessionID, messageID, phase, startedAt: null, finishedAt: null, role: "user", parentMessageID: null,
    actualAgent: null, agentBasis: "unknown", actualModel: null, modelBasis: "unknown",
    routerEligibility: "unknown", routerExposure: "unknown", bypassReason: "unknown",
    routeDecisionID: null, routeSkillName: null, adviceInserted: null, requestEvidence: "unknown",
    configGeneration: null, closureReason: "unknown",
  }
}

function insertTurnRows(
  db: Database,
  rows: Array<{ sessionID: string; messageID: string; phase: "pending" | "terminal"; recordedAt: number; sequence: number }>,
): void {
  const insert = db.query(`
    INSERT INTO facts (kind, session_id, fact_key, phase, conflict, payload_json, semantic_hash, recorded_at, updated_at, sequence)
    VALUES ('turn_context', ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `)
  for (const row of rows) {
    const payload = JSON.stringify(turnPayload(row.sessionID, row.messageID, row.phase))
    insert.run(
      row.sessionID, row.messageID, row.phase, payload, createHash("sha256").update(payload).digest("hex"),
      row.recordedAt, row.recordedAt, row.sequence,
    )
  }
}

function writeProjectCampaignConfig(campaignID: string, ownerBinding: string, projectRoot = root): void {
  const directory = join(projectRoot, ".lca")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "lca.jsonc"), JSON.stringify({
    skill_observation: { enabled: true, campaign_id: campaignID, owner_binding: ownerBinding },
  }))
}

function seedLargeLedger(pendingTurns: number, totalRows: number): void {
  const db = new Database(skillObservationDatabasePath(root))
  const campaign = db.query("SELECT salt, activated_at FROM campaigns WHERE singleton = 1").get() as { salt: string; activated_at: number }
  const sessionID = "bounded_relation_session"
  const sessionKey = createHash("sha256").update(`${campaign.salt}\0session\0${sessionID}`).digest("hex")
  const factRows = totalRows - 2 // one campaign control row and one session admission row
  if (pendingTurns > factRows) throw new Error("pending turn fixture exceeds its fact-row budget")
  const transaction = db.transaction(() => {
    db.query("INSERT INTO session_keys (key_hash, admitted_at) VALUES (?, ?)").run(sessionKey, campaign.activated_at)
    db.query("UPDATE campaigns SET session_count = 1, next_sequence = ? WHERE singleton = 1").run(factRows)
    insertTurnRows(db, Array.from({ length: pendingTurns }, (_, index) => ({
      sessionID, messageID: `pending_${index}`, phase: "pending" as const,
      recordedAt: campaign.activated_at, sequence: index + 1,
    })))
    const insert = db.query(`
      INSERT INTO facts (kind, session_id, fact_key, phase, conflict, payload_json, semantic_hash, recorded_at, updated_at, sequence)
      VALUES ('turn_context', ?, ?, 'terminal', 0, ?, ?, ?, ?, ?)
    `)
    for (let index = 0; index < factRows - pendingTurns; index++) {
      const sequence = pendingTurns + index + 1
      const messageID = `archive_${index}`
      const payload = JSON.stringify(turnPayload(sessionID, messageID, "terminal"))
      insert.run(
        sessionID, messageID, payload, createHash("sha256").update(payload).digest("hex"),
        campaign.activated_at, campaign.activated_at, sequence,
      )
    }
  })
  transaction.immediate()
  db.close()
}
