import { describe, expect, test } from "bun:test"
import {
  RETURNED_BODY_BASIS, RETURNED_PAYLOAD_BASIS, summarizeSkillEvaluation,
} from "../src/telemetry/skill-evaluation.ts"

const digest = (letter: string) => letter.repeat(64)

function turnFact(
  sessionID: string,
  messageID: string,
  role: "user" | "assistant",
  extra: Record<string, unknown> = {},
  phase: "pending" | "terminal" = "terminal",
) {
  return {
    kind: "turn_context", sessionID, factKey: messageID, phase, conflict: false, recordedAt: 1,
    payload: { sessionID, messageID, role, ...extra },
  }
}

type CallOptions = {
  sessionID?: string
  callID?: string
  messageID?: string | null
  state?: "pending" | "completed" | "error" | "aborted" | "unknown"
  requestedName?: string | null
  returnedName?: string | null
  returnedContent?: "observed" | "not_returned" | "unknown"
  bodySha256?: string | null
  bodyBasis?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
  conflict?: boolean
  phase?: "pending" | "terminal" | "conflict"
  taskID?: string
  attemptID?: string
  routeDecisionID?: string
}

function skillCall(options: CallOptions = {}) {
  const sessionID = options.sessionID ?? "session_1"
  const callID = options.callID ?? "call_1"
  const state = options.state ?? "completed"
  return {
    kind: "skill_call", sessionID, factKey: callID, phase: options.phase ?? (state === "pending" ? "pending" : "terminal"),
    conflict: options.conflict ?? false, recordedAt: 2,
    payload: {
      sessionID,
      callID,
      messageID: options.messageID === undefined ? "assistant_1" : options.messageID,
      state,
      returnedContent: options.returnedContent ?? (state === "completed" ? "observed" : state === "pending" ? "unknown" : "not_returned"),
      requestedName: options.requestedName === undefined ? "plan" : options.requestedName,
      returnedName: options.returnedName === undefined ? "plan" : options.returnedName,
      returnedPayloadSha256: digest("c"),
      returnedPayloadBasis: RETURNED_PAYLOAD_BASIS,
      returnedBodySha256: options.bodySha256 === undefined ? digest("a") : options.bodySha256,
      returnedBodyBasis: options.bodyBasis === undefined ? RETURNED_BODY_BASIS : options.bodyBasis,
      startedAt: options.startedAt,
      finishedAt: options.finishedAt,
      durationMs: options.durationMs,
      taskID: options.taskID,
      attemptID: options.attemptID,
      routeDecisionID: options.routeDecisionID,
    },
  }
}

function taskFact(options: {
  sessionID?: string
  taskID: string
  attemptID: string
  ownerSessionID: string
  childSessionID: string
  status: "started" | "done" | "failed" | "cancelled" | "unknown"
  taskKind?: "code" | "data" | "unknown"
  actualRole?: "main" | "worker" | "reviewer" | "data-analyst" | "data-verifier" | "unknown"
  roleBasis?: "sdk_agent_field" | "host_metadata" | "code_owned" | "unknown"
  messageID?: string | null
  childMessageID?: string | null
  resumeRequested?: boolean | null
  taskStatus?: "done" | "failed" | "cancelled" | "open" | "unknown" | null
  phase?: "pending" | "terminal"
}) {
  const sessionID = options.sessionID ?? options.ownerSessionID
  const phase = options.phase ?? (options.status === "started" ? "pending" : "terminal")
  const factKey = `fact_${options.taskID}_${options.attemptID}`
  return {
    kind: "task_context", sessionID, factKey, phase, conflict: false, recordedAt: 3,
    payload: {
      sessionID, taskID: options.taskID, attemptID: options.attemptID, ownerSessionID: options.ownerSessionID,
      childSessionID: options.childSessionID, status: options.status, taskKind: options.taskKind ?? "code",
      actualRole: options.actualRole ?? "main", roleBasis: options.roleBasis ?? "code_owned",
      messageID: options.messageID ?? null, childMessageID: options.childMessageID ?? null,
      resumeRequested: options.resumeRequested ?? null, taskStatus: options.taskStatus ?? null,
    },
  }
}

function verificationFact(options: {
  verificationID: string
  status: "started" | "pass" | "fail" | "refused" | "invalidated" | "timed_out" | "aborted" | "not_run" | "unknown"
  codeOwned: boolean
  exitCode?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
  taskStatus?: "done" | "failed" | "cancelled" | "open" | "unknown"
  reviewVerdict?: "accept" | "revise" | "reject" | "skipped" | "error" | "unknown"
}) {
  const sessionID = "session_1"
  const phase = options.status === "started" ? "pending" : "terminal"
  return {
    kind: "verification_observation", sessionID, factKey: options.verificationID, phase, conflict: false, recordedAt: 4,
    payload: {
      sessionID, verificationID: options.verificationID, taskID: "task_1", attemptID: "attempt_1",
      status: options.status, codeOwned: options.codeOwned, exitCode: options.exitCode,
      startedAt: options.startedAt, finishedAt: options.finishedAt, durationMs: options.durationMs,
      taskStatus: options.taskStatus, reviewVerdict: options.reviewVerdict,
    },
  }
}

function toolFact(options: {
  callID: string
  messageID: string
  startedAt: number
  finishedAt: number
  durationMs: number
  status?: "pending" | "completed" | "error" | "unknown"
}) {
  const sessionID = "session_1"
  const status = options.status ?? "completed"
  return {
    kind: "tool_context", sessionID, factKey: options.callID, phase: status === "pending" ? "pending" : "terminal",
    conflict: false, recordedAt: 5,
    payload: { sessionID, callID: options.callID, messageID: options.messageID, tool: "bash", status,
      startedAt: options.startedAt, finishedAt: options.finishedAt, durationMs: options.durationMs },
  }
}

describe("bounded skill evaluation summary", () => {
  test("keeps conflicts out of success counts and partitions hash, role, model, and config strata", () => {
    const first = skillCall({ callID: "call_1" })
    const contradictoryReplay = {
      ...first,
      payload: { ...first.payload, state: "error", returnedContent: "not_returned" },
    }
    const facts = [
      first,
      contradictoryReplay,
      skillCall({ callID: "call_2" }),
      skillCall({ callID: "call_3", bodySha256: digest("b"), bodyBasis: "alternate-renderer.v2" }),
      skillCall({ callID: "call_4", state: "error" }),
      skillCall({ callID: "call_name_conflict", requestedName: "plan", returnedName: "write" }),
      turnFact("session_1", "assistant_1", "assistant", {
        parentMessageID: "user_1", actualAgent: "main", agentBasis: "sdk_agent_field",
        actualModel: "model-a", modelBasis: "sdk_model_field",
      }),
      turnFact("session_1", "user_1", "user", {
        closureReason: "completed", requestEvidence: "none", routerExposure: "none", configGeneration: digest("d"),
      }),
    ]
    const summary = summarizeSkillEvaluation(facts, {
      campaignID: "campaign_1", durableQuotaCalls: 100, storedFacts: 20,
      period: { startAt: 100, endAt: 200, basis: "campaign" },
    })

    expect(summary.calls).toMatchObject({
      includedUniqueCalls: 5, durableQuotaCalls: 100, completedToolCalls: 2,
      errorOrAbortedToolCalls: 1, unresolvedCalls: 0, conflicts: 2,
    })
    expect(summary.calls.stateCoverage).toMatchObject({ numerator: 3, denominator: 5, display: "3/5", excluded: 2 })
    expect(summary.calls.stateCoverage).toMatchObject({
      campaignID: "campaign_1", period: { startAt: 100, endAt: 200, basis: "campaign" }, coverage: { storedFacts: 20 },
    })
    expect(summary.fingerprints.returnedBody).toMatchObject({ numerator: 2, denominator: 2, display: "2/2" })
    expect(summary.coverage.duplicateFacts).toBe(1)
    expect(summary.coverage.duplicateConflictIdentities).toBe(1)
    expect(summary.strata).toHaveLength(3)
    expect(summary.strata.map((stratum) => [stratum.returnedBodySha256, stratum.returnedBodyBasis])).toContainEqual([
      digest("a"), RETURNED_BODY_BASIS,
    ])
    expect(summary.strata.map((stratum) => [stratum.returnedBodySha256, stratum.returnedBodyBasis])).toContainEqual([
      digest("b"), "alternate-renderer.v2",
    ])
    expect(summary.strata.find((stratum) => stratum.returnedBodySha256 === digest("b"))).toMatchObject({
      actualRole: "main", actualModel: "model-a", configGeneration: digest("d"),
    })
    expect(summary.scope).toMatchObject({ campaignID: "campaign_1", period: { basis: "campaign" } })
  })

  test("joins skill calls through message parents, not call metadata, and keeps advice-only turns in the denominator", () => {
    const facts = [
      turnFact("session_1", "user_1", "user", {
        closureReason: "completed", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "decision_1", routeSkillName: "plan", requestEvidence: "unknown",
      }),
      turnFact("session_1", "assistant_1", "assistant", { parentMessageID: "user_1" }),
      turnFact("session_1", "user_2", "user", {
        closureReason: "completed", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "decision_2", routeSkillName: "plan", requestEvidence: "unknown",
      }),
      turnFact("session_1", "user_conflicted", "user", {
        closureReason: "completed", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "decision_conflicted", routeSkillName: "plan",
      }),
      turnFact("session_1", "user_conflicted", "user", {
        closureReason: "completed", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "decision_conflicted_other", routeSkillName: "plan",
      }),
      turnFact("session_1", "assistant_conflicted", "assistant", { parentMessageID: "user_3" }),
      turnFact("session_1", "assistant_conflicted", "assistant", { parentMessageID: "user_4" }),
      skillCall({ callID: "call_1", messageID: "assistant_1" }),
      skillCall({ callID: "call_missing_assistant", messageID: "missing_assistant" }),
      skillCall({ callID: "call_missing_user", messageID: "assistant_missing_user" }),
      turnFact("session_1", "assistant_missing_user", "assistant", { parentMessageID: "missing_user" }),
      skillCall({ callID: "call_conflicted_parent", messageID: "assistant_conflicted" }),
    ]
    const summary = summarizeSkillEvaluation(facts)

    expect(summary.advice).toMatchObject({
      exactExposures: 2,
      exposuresWithSameTurnSkillCall: 1,
      followThrough: { numerator: 1, denominator: 2, display: "1/2", excluded: 1, censored: 0 },
      callsJoinedToAdvice: 1,
      sameTurnSkillCalls: 1,
      callAncestry: { unknown: 2, conflicts: 1 },
    })
    expect(summary.advice.confirmedAutonomyRate).toBeNull()
  })

  test("censors advice follow-through for open, compacted, deleted, and unknown turn closure", () => {
    const facts = [
      turnFact("session_1", "user_complete", "user", {
        closureReason: "completed", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "route_complete", routeSkillName: "plan",
      }),
      turnFact("session_1", "assistant_complete", "assistant", { parentMessageID: "user_complete" }),
      turnFact("session_1", "user_pending", "user", {
        closureReason: "unknown", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "route_pending", routeSkillName: "plan",
      }, "pending"),
      turnFact("session_1", "user_compacted", "user", {
        closureReason: "compacted", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "route_compacted", routeSkillName: "plan",
      }),
      turnFact("session_1", "user_deleted", "user", {
        closureReason: "deleted", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "route_deleted", routeSkillName: "plan",
      }),
      turnFact("session_1", "user_unknown", "user", {
        closureReason: "unknown", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "route_unknown", routeSkillName: "plan",
      }),
      skillCall({ callID: "call_complete", messageID: "assistant_complete" }),
    ]
    const summary = summarizeSkillEvaluation(facts, { notCollectedAfterStop: true })

    expect(summary.advice.followThrough).toMatchObject({
      numerator: 1, denominator: 1, display: "1/1", censored: 4,
    })
    expect(summary.advice.censoredExposures).toBe(4)
  })

  test("excludes reused route identifiers from advice attribution", () => {
    const facts = [
      turnFact("session_1", "user_a", "user", {
        closureReason: "completed", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "reused_decision", routeSkillName: "plan",
      }),
      turnFact("session_1", "user_b", "user", {
        closureReason: "completed", routerExposure: "suggest", adviceInserted: true,
        routeDecisionID: "reused_decision", routeSkillName: "plan",
      }),
    ]
    const summary = summarizeSkillEvaluation(facts)

    expect(summary.advice).toMatchObject({ exactExposures: 0, conflictingExposures: 2 })
    expect(summary.advice.followThrough).toMatchObject({ numerator: 0, denominator: 0, display: "N/A", excluded: 2 })
  })

  test("joins exact child task attempts, keeps orchestrator context separate, and never overwrites retry conflicts", () => {
    const facts = [
      turnFact("session_1", "user_main", "user", { closureReason: "completed", requestEvidence: "none", routerExposure: "none" }),
      turnFact("session_1", "assistant_main", "assistant", { parentMessageID: "user_main", actualAgent: "main" }),
      turnFact("session_1", "assistant_task", "assistant", { parentMessageID: "user_main", actualAgent: "main" }),
      turnFact("child_1", "user_child", "user", { closureReason: "completed", requestEvidence: "none", routerExposure: "none" }),
      turnFact("child_1", "assistant_child", "assistant", { parentMessageID: "user_child", actualAgent: "worker" }),
      turnFact("child_2", "user_child_2", "user", { closureReason: "completed", requestEvidence: "none", routerExposure: "none" }),
      turnFact("child_2", "assistant_child_2", "assistant", { parentMessageID: "user_child_2", actualAgent: "worker" }),
      turnFact("child_3", "user_child_3", "user", { closureReason: "completed", requestEvidence: "none", routerExposure: "none" }),
      turnFact("child_3", "assistant_child_3", "assistant", { parentMessageID: "user_child_3", actualAgent: "reviewer" }),
      taskFact({ taskID: "task_1", attemptID: "attempt_1", ownerSessionID: "session_1", childSessionID: "child_1",
        status: "failed", messageID: "assistant_main", taskStatus: "failed" }),
      taskFact({ sessionID: "child_1", taskID: "task_1", attemptID: "attempt_1", ownerSessionID: "session_1", childSessionID: "child_1",
        status: "done", actualRole: "worker", childMessageID: "user_child" }),
      taskFact({ taskID: "task_1", attemptID: "attempt_2", ownerSessionID: "session_1", childSessionID: "child_2",
        status: "done", messageID: "assistant_main", resumeRequested: true, taskStatus: "done" }),
      taskFact({ sessionID: "child_2", taskID: "task_1", attemptID: "attempt_2", ownerSessionID: "session_1", childSessionID: "child_2",
        status: "done", actualRole: "worker", childMessageID: "user_child_2" }),
      taskFact({ taskID: "task_2", attemptID: "attempt_1", ownerSessionID: "session_1", childSessionID: "child_1",
        status: "done", taskKind: "data", actualRole: "data-analyst", messageID: "assistant_main", taskStatus: "done" }),
      taskFact({ taskID: "task_3", attemptID: "attempt_1", ownerSessionID: "session_1", childSessionID: "child_3",
        status: "done", taskKind: "code", messageID: "assistant_task" }),
      taskFact({ sessionID: "child_3", taskID: "task_1", attemptID: "attempt_2", ownerSessionID: "session_1", childSessionID: "child_3",
        status: "failed", actualRole: "reviewer", childMessageID: "user_child_3" }),
      verificationFact({ verificationID: "task1_verification_failure", status: "fail", codeOwned: true,
        exitCode: 1, taskStatus: "failed" }),
      skillCall({ sessionID: "child_1", callID: "worker_call", messageID: "assistant_child" }),
      skillCall({ sessionID: "session_1", callID: "main_call", messageID: "assistant_main" }),
    ]
    const summary = summarizeSkillEvaluation(facts)

    expect(summary.taskAttribution).toMatchObject({
      exactWorkerTaskAttemptLinks: 1,
      callsWithExactWorkerTaskLinks: 1,
      workerTaskAttemptLinkRate: { numerator: 1, denominator: 1, display: "1/1" },
      orchestratorContextLinks: 3,
      attempts: {
        total: 4, statuses: { done: 3, failed: 1 }, taskKinds: { code: 3, data: 1 },
        resumeRequested: { yes: 1, no: 0, unknown: 3 },
        ledgerTaskStatuses: { done: 2, failed: 1, unknown: 1 },
      },
      finalOwnerTasks: {
        total: 3, statuses: { conflict: 1, done: 2 }, ledgerTaskStatuses: { conflict: 1, done: 1, unknown: 1 },
        childActorFactsExcludedFromTaskTotal: 3,
      },
    })
    expect(summary.taskAttribution.attempts.actualRolesByFact).toMatchObject({ main: 3, worker: 2, reviewer: 1, "data-analyst": 1 })
    expect(summary.verification.statuses.fail).toBe(1)
  })

  test("requires the exact child prompt and trusts the observed message role over reused child sessions", () => {
    const facts = [
      turnFact("owner", "user_owner", "user", { closureReason: "completed" }),
      turnFact("owner", "owner_assistant", "assistant", { parentMessageID: "user_owner", actualAgent: "main" }),
      turnFact("child_reused", "prompt_first", "user", { closureReason: "completed" }),
      turnFact("child_reused", "worker_first", "assistant", { parentMessageID: "prompt_first", actualAgent: "worker" }),
      turnFact("child_reused", "prompt_later", "user", { closureReason: "completed" }),
      turnFact("child_reused", "main_after_switch", "assistant", { parentMessageID: "prompt_later", actualAgent: "main" }),
      turnFact("child_reused", "worker_later", "assistant", { parentMessageID: "prompt_later", actualAgent: "worker" }),
      turnFact("child_reused", "role_missing", "assistant", { parentMessageID: "prompt_first" }),
      taskFact({ taskID: "reused_task", attemptID: "attempt_1", ownerSessionID: "owner", childSessionID: "child_reused",
        status: "done", messageID: "owner_assistant" }),
      taskFact({ sessionID: "child_reused", taskID: "reused_task", attemptID: "attempt_1", ownerSessionID: "owner",
        childSessionID: "child_reused", childMessageID: "prompt_first", status: "done", actualRole: "worker" }),
      skillCall({ sessionID: "child_reused", callID: "first_worker_call", messageID: "worker_first" }),
      skillCall({ sessionID: "child_reused", callID: "switched_main_call", messageID: "main_after_switch" }),
      skillCall({ sessionID: "child_reused", callID: "later_worker_call", messageID: "worker_later" }),
      skillCall({ sessionID: "child_reused", callID: "missing_role_call", messageID: "role_missing" }),
    ]
    const summary = summarizeSkillEvaluation(facts)

    expect(summary.taskAttribution).toMatchObject({
      exactWorkerTaskAttemptLinks: 1,
      callsWithExactWorkerTaskLinks: 1,
      workerTaskAttemptLinkRate: { numerator: 1, denominator: 2, unknown: 2, excluded: 1 },
    })
  })

  test("namespaces task attempts and final-task rows by owner session", () => {
    const summary = summarizeSkillEvaluation([
      taskFact({ taskID: "shared_task", attemptID: "shared_attempt", ownerSessionID: "owner_a", childSessionID: "child_a", status: "done", taskStatus: "done" }),
      taskFact({ taskID: "shared_task", attemptID: "shared_attempt", ownerSessionID: "owner_b", childSessionID: "child_b", status: "failed", taskStatus: "failed" }),
    ])

    expect(summary.taskAttribution).toMatchObject({
      attempts: { total: 2, statuses: { done: 1, failed: 1 }, ledgerTaskStatuses: { done: 1, failed: 1 } },
      finalOwnerTasks: { total: 2, statuses: { done: 1, failed: 1 }, ledgerTaskStatuses: { done: 1, failed: 1 } },
    })
  })

  test("validates and includes new lifecycle fields in duplicate-fact conflict detection", () => {
    const turn = turnFact("session_1", "timed_user", "user", { startedAt: 10, finishedAt: 20 })
    const conflictingTurnTime = turnFact("session_1", "timed_user", "user", { startedAt: 11, finishedAt: 20 })
    const invalidTurn = turnFact("session_1", "invalid_user", "user", { startedAt: 30, finishedAt: 29 })
    const task = taskFact({ taskID: "task_1", attemptID: "attempt_1", ownerSessionID: "session_1", childSessionID: "child_1",
      status: "done", resumeRequested: false })
    const conflictingResume = taskFact({ taskID: "task_1", attemptID: "attempt_1", ownerSessionID: "session_1", childSessionID: "child_1",
      status: "done", resumeRequested: true })
    const skippedReview = verificationFact({ verificationID: "review_1", status: "unknown", codeOwned: true, reviewVerdict: "skipped" })
    const errorReview = verificationFact({ verificationID: "review_1", status: "unknown", codeOwned: true, reviewVerdict: "error" })
    const summary = summarizeSkillEvaluation([turn, conflictingTurnTime, invalidTurn, task, conflictingResume, skippedReview, errorReview])

    expect(summary.coverage).toMatchObject({ invalidRows: 1, duplicateFacts: 3, duplicateConflictIdentities: 3 })
    expect(summary.taskAttribution.attempts.statuses.conflict).toBe(1)
    expect(summary.verification.statuses.conflict).toBe(1)
  })

  test("requires code-owned consistent verification and strict temporal order for after-load tool relations", () => {
    const facts = [
      turnFact("session_1", "user_1", "user", { closureReason: "completed", requestEvidence: "none", routerExposure: "none" }),
      turnFact("session_1", "assistant_1", "assistant", { parentMessageID: "user_1", actualAgent: "main" }),
      turnFact("session_1", "assistant_tie", "assistant", { parentMessageID: "user_1" }),
      turnFact("session_1", "assistant_after", "assistant", { parentMessageID: "user_1" }),
      turnFact("session_1", "assistant_inverted", "assistant", { parentMessageID: "user_1" }),
      skillCall({ callID: "load", messageID: "assistant_1", startedAt: 10, finishedAt: 20, durationMs: 10 }),
      toolFact({ callID: "tool_tie", messageID: "assistant_tie", startedAt: 20, finishedAt: 25, durationMs: 5 }),
      toolFact({ callID: "tool_after", messageID: "assistant_after", startedAt: 21, finishedAt: 25, durationMs: 4 }),
      toolFact({ callID: "tool_inverted", messageID: "assistant_inverted", startedAt: 26, finishedAt: 24, durationMs: 2 }),
      verificationFact({ verificationID: "verify_pass", status: "pass", codeOwned: true, exitCode: 0,
        startedAt: 10, finishedAt: 12, durationMs: 2, taskStatus: "done", reviewVerdict: "accept" }),
      verificationFact({ verificationID: "verify_fail", status: "fail", codeOwned: true, exitCode: 1,
        startedAt: 20, finishedAt: 21, durationMs: 1, taskStatus: "failed", reviewVerdict: "reject" }),
      verificationFact({ verificationID: "verify_false_pass", status: "pass", codeOwned: false, exitCode: 0,
        startedAt: 30, finishedAt: 33, durationMs: 3, reviewVerdict: "accept" }),
      verificationFact({ verificationID: "verify_exit_conflict", status: "pass", codeOwned: true, exitCode: 1,
        startedAt: 40, finishedAt: 41, durationMs: 1 }),
      verificationFact({ verificationID: "verify_time_conflict", status: "pass", codeOwned: true, exitCode: 0,
        startedAt: 50, finishedAt: 49 }),
      verificationFact({ verificationID: "verify_invalidated", status: "invalidated", codeOwned: true, exitCode: 0 }),
      verificationFact({ verificationID: "verify_not_run", status: "not_run", codeOwned: true, exitCode: 0, reviewVerdict: "skipped" }),
      verificationFact({ verificationID: "verify_review_error", status: "unknown", codeOwned: true, reviewVerdict: "error" }),
    ]
    const summary = summarizeSkillEvaluation(facts)

    expect(summary.verification).toMatchObject({
      statuses: { pass: 1, fail: 1, excluded: 1, conflict: 2, invalidated: 1, not_run: 1, unknown: 1 },
      exitZero: { numerator: 1, denominator: 2, display: "1/2" },
      invalidTimestampCount: 1,
      reviewVerdicts: { accept: 2, reject: 1, skipped: 1, error: 1 },
    })
    expect(summary.relatedTools.sameTurn).toMatchObject({ uniqueToolCalls: 3, relations: 3, unscannedRelations: 0, truncated: false })
    expect(summary.relatedTools.afterLoadSameTurn).toMatchObject({ uniqueToolCalls: 1, relations: 1, unscannedRelations: 0, truncated: false })
    expect(summary.relatedTools.durations).toMatchObject({ samples: 2, invalid: 1, missing: 0 })
    expect(summary.calls.duration).toMatchObject({ samples: 1, missing: 0, totalMs: 10 })
  })

  test("keeps trigger absence, incomplete timestamps, and expired snapshot coverage explicit", () => {
    const facts = [
      turnFact("session_1", "user_1", "user", { closureReason: "completed", requestEvidence: "none", routerExposure: "none" }),
      turnFact("session_1", "assistant_1", "assistant", { parentMessageID: "user_1" }),
      skillCall({ callID: "call_1", messageID: "assistant_1" }),
      skillCall({ callID: "call_2", messageID: null, state: "pending" }),
    ]
    const summary = summarizeSkillEvaluation(facts, {
      durableQuotaCalls: 10, storedFacts: 40, unscannedStoredFacts: 7, expiredFacts: 5,
      truncated: true, unscannedTotal: "unknown", notCollectedAfterStop: true,
    })

    expect(summary.advice.callTriggerCounts).toMatchObject({ noObservedTrigger: 1 })
    expect(summary.advice.confirmedAutonomyRate).toBeNull()
    expect(summary.calls).toMatchObject({ includedUniqueCalls: 2, durableQuotaCalls: 10, unresolvedCalls: 1, censoredUnresolvedCalls: 1 })
    expect(summary.calls.duration).toMatchObject({ samples: 0, missing: 1 })
    expect(summary.coverage).toMatchObject({
      storedFacts: 40, unscannedStoredFacts: 7, expiredFacts: 5, truncated: true, unscannedTotal: "unknown",
      notCollectedAfterStop: true, durableQuotaCalls: 10, populationComplete: false, unobservedPopulation: "unknown",
    })
    expect(summary.fingerprints.returnedBody.display).toBe("1/1")
    expect(summarizeSkillEvaluation([]).fingerprints.returnedBody).toMatchObject({ display: "N/A", numerator: 0, denominator: 0 })
  })

  test("bounds same-turn relation fan-out and reports links omitted by the evaluator cap", () => {
    const facts = [
      turnFact("session_1", "user_1", "user", { closureReason: "completed" }),
      turnFact("session_1", "assistant_skill", "assistant", { parentMessageID: "user_1" }),
      turnFact("session_1", "assistant_tool", "assistant", { parentMessageID: "user_1" }),
      ...Array.from({ length: 300 }, (_, index) => skillCall({
        callID: `call_${index}`, messageID: "assistant_skill", startedAt: 1, finishedAt: 2, durationMs: 1,
      })),
      ...Array.from({ length: 300 }, (_, index) => toolFact({
        callID: `related_tool_${index}`, messageID: "assistant_tool", startedAt: 4, finishedAt: 5, durationMs: 1,
      })),
    ]
    const summary = summarizeSkillEvaluation(facts)

    expect(summary.relatedTools.sameTurn).toMatchObject({ relations: 50_000, unscannedRelations: 40_000, truncated: true })
    expect(summary.relatedTools.afterLoadSameTurn).toMatchObject({
      relations: 50_000, unscannedRelations: 40_000, truncated: true,
    })
    expect(summary.coverage).toMatchObject({ unscannedSameTurnRelations: 40_000, relationsTruncated: true })
  })
})
