import { spawnSync } from "node:child_process"
import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const framework = fileURLToPath(new URL("../", import.meta.url))
const harness = fileURLToPath(new URL("./pty/tui.py", import.meta.url))
// Bun tests run concurrently and some neighboring suites mutate PATH and
// state-home variables while building child fixtures. Freeze the invocation
// environment before tests start so PTY child resolution is not timing-based.
const harnessEnvironment: NodeJS.ProcessEnv = { ...process.env }
const python = harnessEnvironment.PYTHON ?? "python3"
const required = harnessEnvironment.LCA_TUI_PTY_REQUIRED === "1"
const preflight = spawnSync(python, [harness, "--check"], {
  cwd: framework,
  encoding: "utf8",
  env: harnessEnvironment,
  maxBuffer: 1024 * 1024,
})
let prerequisitesAvailable = false
try {
  prerequisitesAvailable = JSON.parse(preflight.stdout || "{}").available === true
} catch {
  prerequisitesAvailable = false
}

const optionalPrerequisiteSkip = !required && !prerequisitesAvailable
const restoredTerminalProof = {
  termiosRestored: true,
  terminalCleanupEvidence: {
    source: "parent tcgetattr on PTY slave after runInteractiveSession cleanup",
    capturedAfterInteractiveCleanup: true,
    capturedBeforeFixtureExit: true,
    termiosRestored: true,
    canonical: true,
    echo: true,
  },
}

test.skipIf(optionalPrerequisiteSkip)("readline engine and manual-model pickers cancel or exit without starting a runtime", () => {
  const result = spawnSync(python, [harness, "--readline-pickers-only"], {
    cwd: framework,
    encoding: "utf8",
    env: harnessEnvironment,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  })
  const diagnostic = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n")
  expect(result.error, diagnostic).toBeUndefined()
  expect(result.status, diagnostic).toBe(0)
  const report = JSON.parse(result.stdout) as {
    status: string
    cases: Record<string, { exitCode: number; fixture: Record<string, unknown>; capture: Record<string, unknown> }>
  }
  expect(report.status).toBe("passed")
  expect(Object.keys(report.cases).sort()).toEqual([
    "engine-cancel", "engine-eof", "engine-escape", "model-cancel", "model-eof", "model-escape",
  ])
  for (const [name, result] of Object.entries(report.cases)) {
    expect(result.exitCode, name).toBe(0)
    expect(result.fixture, name).toMatchObject({
      runtimeCreateCount: 0, runtimeAdmissionCount: 0, turnCount: 0, decisionCount: 0, runCount: 0,
      modelCatalogCallCount: name.startsWith("model-") ? 1 : 0,
    })
    expect(result.fixture.error, name).toBeUndefined()
    expect(result.capture, name).toMatchObject(restoredTerminalProof)
  }
}, 75_000)

test.skipIf(optionalPrerequisiteSkip)("production TUI runs through a real Python PTY with truthful workflow evidence", () => {
  const args = [harness]
  const evidencePath = harnessEnvironment.LCA_TUI_PTY_OUT
  if (evidencePath) args.push("--out", evidencePath)
  const result = spawnSync(python, args, {
    cwd: framework,
    encoding: "utf8",
    env: harnessEnvironment,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  })
  const diagnostic = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n")
  expect(result.error, `Python PTY harness launch failed: ${diagnostic}`).toBeUndefined()
  expect(result.status, `PTY harness failed; required=${required}, preflight=${preflight.status}\n${diagnostic}`).toBe(0)

  type SkillRestoreReport = {
    mode: string
    originalSessionID: string
    originalExitCode: number
    originalGrantRow: { sid: string; name: string; source: string; classification: string; hash: string; scope: string }
    originalConsentHash: string
    restoredExitCode: number
    restoredFixture: Record<string, unknown> & { sourceChoices: Array<Record<string, unknown>>; skillHandoffs: unknown[] }
    capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
    restoredPromptCount: number
    restoredConsentHash: string
  }
  const report = JSON.parse(result.stdout) as {
    status: string
    scope: string
    scenarios: {
      approve: {
        fixture: Record<string, unknown> & { toolActivityEvents: Array<Record<string, unknown>> }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      reject: { fixture: Record<string, unknown>; capture: Record<string, unknown> }
      busyFifo: { fixture: Record<string, unknown>; capture: Record<string, unknown> }
      restore: {
        exitCode: number
        fixture: Record<string, unknown>
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      sdkObserver: {
        exitCode: number
        fixture: Record<string, unknown>
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      skills: {
        exitCode: number
        fixture: Record<string, unknown> & {
          events: Array<Record<string, unknown>>
          sourceChoices: Array<Record<string, unknown>>
          skillHandoffs: Array<Record<string, unknown>>
          runtimeSelections: Array<Record<string, unknown>>
        }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      readlineSkills: {
        exitCode: number
        fixture: Record<string, unknown> & {
          events: Array<Record<string, unknown>>
          sourceChoices: Array<Record<string, unknown>>
          skillHandoffs: Array<Record<string, unknown>>
        }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      skillGrants: {
        exitCode: number
        fixture: Record<string, unknown> & { sourceChoices: Array<Record<string, unknown>>; skillHandoffs: Array<Record<string, unknown>> }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
        grantRow: { sid: string; name: string; source: string; classification: string; hash: string; scope: string }
        consentHash: string
        repromptHash: string
        promptCountBeforeRevoke: number
        promptCountAfterRevoke: number
      }
      skillRestoreExit: SkillRestoreReport
      skillRestoreKill: SkillRestoreReport
      skillToolScope: {
        exitCode: number
        fixture: Record<string, unknown> & {
          events: Array<Record<string, unknown>>
          nativeToolActivities: Array<Record<string, unknown>>
          planExecutionEvidence: Array<Record<string, unknown>>
          skillModelRequests: Array<Record<string, unknown>>
          skillModelResponses: Array<Record<string, unknown>>
          sourceChoices: Array<Record<string, unknown>>
          toolPermissionChoices: Array<Record<string, unknown>>
        }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      workflowDI: {
        exitCode: number
        fixture: Record<string, unknown> & {
          workflowStatuses: Array<string | null>
          workflowChoices: Array<{ title: string; values: string[]; answer: number | null }>
          workflowModelRequests: Record<string, number>
          workflowEvidence: Record<string, unknown>
          skillModelServer: { endpoint: string; simulated: boolean }
        }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      skillToolCancel: {
        exitCode: number
        fixture: Record<string, unknown> & {
          nativeToolActivities: Array<Record<string, unknown>>
          planExecutionEvidence: Array<Record<string, unknown>>
          toolPermissionChoices: Array<Record<string, unknown>>
        }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      skillMainWrite: {
        exitCode: number
        fixture: Record<string, unknown> & {
          nativeToolActivities: Array<Record<string, unknown>>
          planExecutionEvidence: Array<Record<string, unknown>>
          sourceChoices: Array<Record<string, unknown>>
          toolPermissionChoices: Array<Record<string, unknown>>
        }
        capture: Record<string, unknown> & { modeProof: Record<string, unknown> }
      }
      pauseResume: { exitCode: number; fixture: Record<string, unknown> & { stopEvidence: Record<string, unknown> }; capture: Record<string, unknown> & { modeProof: Record<string, unknown> } }
      cancelUnconfirmed: { exitCode: number; fixture: Record<string, unknown> & { stopEvidence: Record<string, unknown> } }
      pausedCancel: { exitCode: number; fixture: Record<string, unknown> & { stopEvidence: Record<string, unknown> } }
      ctrlCThresholds: {
        exitCode: number
        fixture: Record<string, unknown>
        capture: Record<string, unknown>
        separatedClear: {
          actualIntervalNanoseconds: number
          actualIntervalMs: number
          thresholdMs: number
          relation: string
          composerCleared: boolean
          sessionRemainedRunning: boolean
        }
        doubleExit: {
          actualIntervalNanoseconds: number
          actualIntervalMs: number
          thresholdMs: number
          relation: string
          firstCtrlCClearedComposer: boolean
          exitCode: number
        }
      }
      signals: {
        SIGINT: { exitCode: number; capture: Record<string, unknown> }
        SIGTERM: { exitCode: number; capture: Record<string, unknown> }
        SIGHUP: { exitCode: number; capture: Record<string, unknown> }
      }
    }
    coverage: { notCovered: string[] }
  }
  expect(report.status).toBe("passed")
  // P5b: real-controller stop scenarios (production queue, settlement routine and TUI; synthetic host).
  expect(report.scenarios.pauseResume.exitCode).toBe(0)
  expect(report.scenarios.pauseResume.fixture.stopEvidence).toMatchObject({ phase: "done", taskStatuses: ["done", "done", "done"] })
  expect(report.scenarios.pauseResume.capture.modeProof).toMatchObject({ pausingLabelVisible: true, pausedAfterProof: true, residualShown: true })
  expect(report.scenarios.cancelUnconfirmed.exitCode).toBe(0)
  expect(report.scenarios.cancelUnconfirmed.fixture.stopEvidence).toMatchObject({ phase: "cancelled" })
  expect(report.scenarios.pausedCancel.exitCode).toBe(0)
  expect(report.scenarios.pausedCancel.fixture.stopEvidence).toMatchObject({ phase: "cancelled" })
  expect(report.scope).toContain("no live model inference or genuine external engine proof")

  const approved = report.scenarios.approve.fixture
  expect(approved).toMatchObject({
    turnCount: 1,
    validationCount: 1,
    importCount: 1,
    humanDecisionCalls: 1,
    decisionCount: 1,
    receiptConsumed: true,
    runCount: 1,
    runBeforeReceipt: false,
    noPlanExecutionBeforeReceipt: true,
  })
  const rejected = report.scenarios.reject.fixture
  expect(rejected).toMatchObject({
    turnCount: 1,
    validationCount: 1,
    importCount: 1,
    humanDecisionCalls: 1,
    decisionCount: 1,
    receiptConsumed: true,
    runCount: 0,
    runBeforeReceipt: false,
    noPlanExecutionBeforeReceipt: true,
  })
  expect(report.scenarios.busyFifo.fixture).toMatchObject({
    turnInputs: ["first turn", "queued one", "queued two"],
    turnCount: 3,
    maxConcurrentTurns: 1,
    runCount: 0,
  })
  expect(report.scenarios.approve.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(report.scenarios.reject.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(report.scenarios.busyFifo.capture).toMatchObject(restoredTerminalProof)

  const restored = report.scenarios.restore
  expect(restored.exitCode).toBe(0)
  expect(restored.fixture).toMatchObject({
    turnInputs: [],
    turnCount: 0,
    runCount: 0,
    restoreSeed: {
      sessionID: "pty-restored-session",
      pairCount: 102,
      segmentCount: 4,
      earliestPairInFirstSegment: true,
      metadata: { engine: "codex", model: "pty-fixture-model", held: true },
    },
    restoreRetained: {
      sessionID: "pty-restored-session",
      replayComplete: true,
      metadata: { engine: "codex", model: "pty-fixture-model", held: true },
    },
  })
  const restoreFixture = restored.fixture as {
    restoreSeed: { recordCount: number; segmentCount: number }
    restoreRetained: { recordCount: number; totalRecords: number; segmentCount: number }
  }
  expect(restoreFixture.restoreSeed.segmentCount).toBeGreaterThan(3)
  expect(restoreFixture.restoreRetained.recordCount).toBe(restoreFixture.restoreRetained.totalRecords)
  expect(restoreFixture.restoreRetained.recordCount).toBeGreaterThan(restoreFixture.restoreSeed.recordCount)
  expect(restoreFixture.restoreRetained.segmentCount).toBeGreaterThan(3)
  expect(restored.capture).toMatchObject(restoredTerminalProof)
  expect(restored.capture.modeProof).toMatchObject({
    restoredDraftVisible: true,
    restoredQueueRetainedUnsent: true,
    historyEscapeRestoredDraft: true,
    oldestSegmentSearchVisible: true,
    historyEnterInsertedWithoutDispatch: true,
    continueKeepPreservedHold: true,
    ordinaryMessageRefused: true,
    altScreenRestored: true,
  })

  const sdkObserver = report.scenarios.sdkObserver
  expect(sdkObserver.exitCode).toBe(0)
  expect(sdkObserver.fixture).toMatchObject({
    turnInputs: ["ordinary input after SDK observer"],
    turnCount: 1,
    runCount: 0,
    runtimeCreateCount: 2,
    runtimeAdmissionCount: 2,
    controllerCreateCount: 2,
    conversationCreateCount: 2,
    modelCatalogCallCount: 0,
    controllerStatusCallCount: 0,
    controllerCancelCallCount: 0,
    validationCount: 0,
    importCount: 0,
    humanDecisionCalls: 0,
    decisionCount: 0,
    receiptConsumed: false,
    sdkSeed: {
      sessionID: "pty-retained-sdk-session",
      recordCount: 2,
      attachmentState: "released",
      metadata: { engine: "opencode", held: true },
    },
    sdkRetained: {
      replayComplete: true,
      recordCount: 2,
      totalRecords: 2,
      metadata: { engine: "opencode", held: true },
      attachmentReceiptCount: 1,
      attachmentState: "released",
      attachLockExists: false,
    },
    runtimeSelections: [
      { engine: "codex", model: "pty-fixture-model", sessionID: "lca-pty-session" },
      { engine: "codex", model: "pty-fixture-model", sessionID: "lca-pty-session-2" },
    ],
  })
  const sdkFixture = sdkObserver.fixture as {
    sdkSeed: { metadata: Record<string, unknown> }
    sdkRetained: { metadata: Record<string, unknown> }
  }
  expect(sdkFixture.sdkSeed.metadata).not.toHaveProperty("model")
  expect(sdkFixture.sdkRetained.metadata).not.toHaveProperty("model")
  expect(sdkObserver.capture).toMatchObject(restoredTerminalProof)
  expect(sdkObserver.capture.modeProof).toMatchObject({
    sdkObserverBannerAndHistory: true,
    sdkObserverSearchVisible: true,
    sdkObserverCommandsRefused: true,
    newCliSessionAllocated: true,
    newCliTurnWorks: true,
    sdkMetadataAndWriterUntouched: true,
    altScreenRestored: true,
  })

  const skills = report.scenarios.skills
  expect(skills.exitCode).toBe(130)
  expect(skills.fixture).toMatchObject({
    exitCode: 130,
    runtimeCreateCount: 2,
    runtimeAdmissionCount: 2,
    controllerCreateCount: 2,
    conversationCreateCount: 2,
    turnInputs: [
      "/skill:pty-inspect inspect via inserted completion",
      "/skill:pty-inspect reuse same-session grant",
      "/skill:pty-inspect after new session",
    ],
    turnCount: 3,
    activeTurns: 0,
    runCount: 0,
    skillHomeIsolated: true,
    modelCatalogCallCount: 0,
    modelTransportStub: { command: "ollama", invocations: 0 },
    runtimeSelections: [
      { engine: "local", model: "pty-fixture-model", sessionID: "lca-pty-session" },
      { engine: "local", model: "pty-fixture-model", sessionID: "lca-pty-session-2" },
    ],
    sourceChoices: [
      { sessionID: "lca-pty-session", values: ["Allow this content in this session", "Deny"], answer: 1 },
      { sessionID: "lca-pty-session", values: ["Allow this content in this session", "Deny"], answer: 0 },
      { sessionID: "lca-pty-session-2", values: ["Allow this content in this session", "Deny"], answer: 0 },
      { sessionID: "lca-pty-session-2", values: ["Allow this content in this session", "Deny"], answer: null },
    ],
    skillHandoffs: [
      { sessionID: "lca-pty-session", turn: 1, name: "pty-inspect", exactSource: true },
      { sessionID: "lca-pty-session", turn: 2, name: "pty-inspect", exactSource: true },
      { sessionID: "lca-pty-session-2", turn: 3, name: "pty-inspect", exactSource: true },
    ],
  })
  expect(skills.fixture.events.filter(event => event.type === "runtime.realCliCreated")).toHaveLength(2)
  expect(skills.fixture.events.filter(event => event.type === "runtime.preflight.accepted")).toHaveLength(2)
  expect(skills.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(skills.capture.modeProof).toMatchObject({
    projectSkillCatalogRendered: true,
    completionInsertedIntoComposer: true,
    declinedSourceConsentDidNotDispatch: true,
    acceptedSourceConsentDispatched: true,
    grantReusedWithinSession: true,
    newSessionRequiredFreshConsent: true,
    ctrlCAbortedPendingSourceConsent: true,
    realRuntimeAndAdmission: true,
    externalModelTransportNotInvoked: true,
    rawAtSkillChoice: true,
    altScreenRestored: true,
  })

  const readlineSkills = report.scenarios.readlineSkills
  expect(readlineSkills.exitCode).toBe(0)
  expect(readlineSkills.fixture).toMatchObject({
    exitCode: 0,
    runtimeCreateCount: 1,
    runtimeAdmissionCount: 1,
    controllerCreateCount: 1,
    conversationCreateCount: 1,
    turnInputs: ["/skill:pty-inspect accept via readline"],
    turnCount: 1,
    runCount: 0,
    skillHomeIsolated: true,
    modelTransportStub: { command: "ollama", invocations: 0 },
    sourceChoices: [
      { sessionID: "lca-pty-session", values: ["Allow this content in this session", "Deny"], answer: 1 },
      { sessionID: "lca-pty-session", values: ["Allow this content in this session", "Deny"], answer: 0 },
    ],
    skillHandoffs: [
      { sessionID: "lca-pty-session", turn: 1, name: "pty-inspect", exactSource: true },
    ],
  })
  expect(readlineSkills.fixture.events.filter(event => event.type === "runtime.realCliCreated")).toHaveLength(1)
  expect(readlineSkills.fixture.events.filter(event => event.type === "runtime.preflight.accepted")).toHaveLength(1)
  expect(readlineSkills.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(readlineSkills.capture.modeProof).toMatchObject({
    readlineChooserUsesCreateReadlineTerminal: true,
    readlineDeclineDidNotDispatch: true,
    readlineAcceptDispatched: true,
    realRuntimeAndAdmission: true,
    externalModelTransportNotInvoked: true,
  })

  const skillGrants = report.scenarios.skillGrants
  expect(skillGrants.exitCode).toBe(0)
  expect(skillGrants.grantRow).toEqual({
    sid: "lca-pty-session", name: "pty-inspect", source: "project", classification: "custom",
    hash: skillGrants.consentHash, scope: "read",
  })
  expect(skillGrants.consentHash).toMatch(/^[0-9a-f]{64}$/u)
  expect(skillGrants.repromptHash).toBe(skillGrants.consentHash)
  expect(skillGrants.promptCountBeforeRevoke).toBe(1)
  expect(skillGrants.promptCountAfterRevoke).toBe(2)
  expect(skillGrants.fixture).toMatchObject({ turnCount: 1, runCount: 0 })
  expect(skillGrants.fixture.sourceChoices.map(choice => choice.answer)).toEqual([0, 1])
  expect(skillGrants.fixture.skillHandoffs).toHaveLength(1)
  expect(skillGrants.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(skillGrants.capture.modeProof).toMatchObject({
    grantRowListedWithSidNameSourceClassHashScope: true,
    revokedGrantListingEmpty: true,
    revokedSkillRequiredFreshSourceChoice: true,
  })
  for (const restored of [report.scenarios.skillRestoreExit, report.scenarios.skillRestoreKill]) {
    expect(restored.originalSessionID).toBe("lca-pty-skill-a")
    expect(restored.originalExitCode).toBe(restored.mode === "kill" ? -9 : 0)
    expect(restored.originalGrantRow).toMatchObject({ sid: "lca-pty-skill-a", name: "pty-inspect", source: "project", classification: "custom", scope: "read" })
    expect(restored.originalGrantRow.hash).toBe(restored.originalConsentHash)
    expect(restored.restoredExitCode).toBe(0)
    expect(restored.restoredPromptCount).toBe(1)
    expect(restored.restoredConsentHash).toBe(restored.originalConsentHash)
    expect(restored.restoredFixture).toMatchObject({ exitCode: 0, turnCount: 0, skillHandoffs: [], runCount: 0 })
    expect(restored.restoredFixture.sourceChoices.map(choice => choice.values)).toEqual([
      ["Keep held", "Resume"], ["Allow this content in this session", "Deny"],
    ])
    expect(restored.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
    expect(restored.capture.modeProof).toMatchObject({
      restoredSessionHasNoGrants: true,
      explicitResumeKeptGrantsEmpty: true,
      restoredSkillRequiredFreshSourceChoice: true,
    })
  }
  expect(report.scenarios.skillRestoreExit.mode).toBe("exit")
  expect(report.scenarios.skillRestoreKill.mode).toBe("kill")

  const skillToolScope = report.scenarios.skillToolScope
  expect(skillToolScope.exitCode).toBe(0)
  expect(skillToolScope.fixture).toMatchObject({
    exitCode: 0,
    runtimeCreateCount: 1,
    runtimeAdmissionCount: 1,
    controllerCreateCount: 1,
    conversationCreateCount: 1,
    turnInputs: ["/skill:pty-scope grep PTY_SCOPE_NEEDLE in scope-target.txt"],
    turnCount: 1,
    activeTurns: 0,
    runCount: 0,
    skillHomeIsolated: true,
    skillModelServer: { requests: 2, responses: 2, simulated: true },
    skillModelRequests: [
      { model: "pty-fixture-model", hasSkillInstructions: true, priorGrepResult: false },
      { model: "pty-fixture-model", hasSkillInstructions: true, priorGrepResult: true },
    ],
    skillModelResponses: [
      { type: "tool", name: "grep", input: { pattern: "PTY_SCOPE_NEEDLE", path: "scope-target.txt" } },
      { type: "tool", name: "grep", input: { pattern: "PTY_SCOPE_NEEDLE", path: "scope-target.txt" } },
    ],
    sourceChoices: [
      { sessionID: "lca-pty-session", values: ["Allow this content in this session", "Deny"], answer: 0 },
    ],
  })
  expect(String(skillToolScope.fixture.skillModelServer && (skillToolScope.fixture.skillModelServer as Record<string, unknown>).endpoint)).toMatch(/^http:\/\/127\.0\.0\.1:/u)
  expect(skillToolScope.fixture.policyIDBefore).toBe(skillToolScope.fixture.policyIDAfter)
  expect(skillToolScope.fixture.planExecutionEvidence).toMatchObject([{
    ownerSession: "lca-pty-session", role: "main", policyID: skillToolScope.fixture.policyIDBefore,
    kind: "host", hostDispatched: true, outcome: "failed", reconciled: true,
  }])
  expect(skillToolScope.fixture.events.filter(event => event.type === "conversation.planCreated")).toEqual([{
    type: "conversation.planCreated", sessionID: "lca-pty-session", implementation: "createPlanConversation",
  }])
  expect(skillToolScope.fixture.toolPermissionChoices.map(choice => ({
    sessionID: choice.sessionID, values: choice.values, answer: choice.answer,
    scopedToRead: String(choice.title).includes("declared tools: read"), requestedGrep: String(choice.title).includes("Tool: grep"),
  }))).toEqual([
    { sessionID: "lca-pty-session", values: ["Allow once", "Deny"], answer: 0, scopedToRead: true, requestedGrep: true },
    { sessionID: "lca-pty-session", values: ["Allow once", "Deny"], answer: 1, scopedToRead: true, requestedGrep: true },
  ])
  expect(skillToolScope.fixture.nativeToolActivities.filter(event => event.kind === "tool-started" || event.kind === "tool-finished").map(event => ({
    kind: event.kind, role: event.role, tool: event.tool, outcome: event.outcome, ok: event.ok,
  }))).toEqual([
    { kind: "tool-started", role: "main", tool: "grep", outcome: undefined, ok: undefined },
    { kind: "tool-finished", role: "main", tool: "grep", outcome: "succeeded", ok: true },
    { kind: "tool-started", role: "main", tool: "grep", outcome: undefined, ok: undefined },
    { kind: "tool-finished", role: "main", tool: "grep", outcome: "denied", ok: false },
  ])
  expect(skillToolScope.fixture.error).toBeUndefined()
  expect(skillToolScope.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(skillToolScope.capture.modeProof).toMatchObject({
    settledFailureRetainsComposer: true,
    grepEffectBlockedUntilOwnerChoice: true,
    oneGrepExecutedAndSameNextCallRequiresChoice: true,
    realPlanConversationAndExecutionIntent: true,
    oneUseToolPermitAndFailedRepeat: true,
    mainPolicyIDUnchanged: true,
    simulatedLocalOllamaHTTPOnly: true,
  })

  const skillToolCancel = report.scenarios.skillToolCancel
  expect(skillToolCancel.exitCode).toBe(130)
  expect(skillToolCancel.fixture).toMatchObject({
    exitCode: 130,
    runtimeCreateCount: 1,
    runtimeAdmissionCount: 1,
    turnCount: 1,
    runCount: 0,
    skillHomeIsolated: true,
    skillModelServer: { requests: 1, responses: 1, simulated: true },
    toolPermissionChoices: [{ sessionID: "lca-pty-session", values: ["Allow once", "Deny"], answer: null }],
  })
  expect(skillToolCancel.fixture.nativeToolActivities.filter(event => event.kind === "tool-started" || event.kind === "tool-finished").map(event => ({
    kind: event.kind, role: event.role, tool: event.tool, outcome: event.outcome, ok: event.ok,
  }))).toEqual([
    { kind: "tool-started", role: "main", tool: "grep", outcome: undefined, ok: undefined },
    { kind: "tool-finished", role: "main", tool: "grep", outcome: "denied", ok: false },
  ])
  expect(skillToolCancel.fixture.policyIDBefore).toBe(skillToolCancel.fixture.policyIDAfter)
  expect(skillToolCancel.fixture.planExecutionEvidence).toMatchObject([{
    ownerSession: "lca-pty-session", role: "main", policyID: skillToolCancel.fixture.policyIDBefore,
    kind: "host", hostDispatched: true, outcome: "cancelled", reconciled: true,
  }])
  expect(skillToolCancel.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(skillToolCancel.capture.modeProof).toMatchObject({
    cancelledGrepEffectBlockedUntilOwnerChoice: true,
    ctrlCAbortedPendingToolPermission: true,
    realPlanConversationAndExecutionIntent: true,
    cancelledToolPermitProducedNoEffect: true,
    mainPolicyIDUnchanged: true,
    simulatedLocalOllamaHTTPOnly: true,
  })

  const workflowDI = report.scenarios.workflowDI
  expect(workflowDI.exitCode).toBe(0)
  expect(workflowDI.fixture).toMatchObject({
    exitCode: 0,
    turnCount: 0,
    runCount: 0,
    skillHomeIsolated: true,
    shadowSkillReachedModel: false,
    skillModelServer: { simulated: true },
    workflowEvidence: {
      kind: "ralplan", stage: "pending_execution", phase: "pending_approval",
      created: ["deep-interview", "ralplan"], ledgerTasks: 0, gjcDirectory: false, implementationFiles: [],
    },
  })
  expect(workflowDI.fixture.workflowChoices.map(choice => ({ first: choice.values[0], answer: choice.answer }))).toEqual([
    { first: "Confirm topology", answer: 0 },
    { first: "Yes, crystallize", answer: 0 },
    { first: "Stop here (planning complete; not executed)", answer: 2 },
  ])
  const statusSegments = workflowDI.fixture.workflowStatuses.filter((line): line is string => line !== null)
  expect(statusSegments[0]).toBe("deep-interview · topology · planning")
  for (const expected of ["deep-interview · answer", "deep-interview · panel", "ralplan · planner", "ralplan · pending_execution"]) {
    expect(statusSegments.some(line => line.startsWith(expected))).toBe(true)
  }
  expect(Object.keys(workflowDI.fixture.workflowModelRequests).sort()).toEqual([
    "di.closure", "di.crystallize", "di.interviewer.question", "di.interviewer.topology", "di.panel.contrarian", "di.panel.researcher",
    "di.panel.simplifier", "di.restate", "di.scorer", "ralplan.architect", "ralplan.critic", "ralplan.planner",
  ])
  expect(workflowDI.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(workflowDI.capture.modeProof).toMatchObject({
    statusDeepInterviewTopology: true, inlineTopologyChoice: true, inlineRestatementChoice: true, statusRalplanPlanner: true,
    consensusDoesNotExecute: true, realEnginesAndWorkflowTurns: true, oneDeepInterviewOneRalplan: true,
    diSpecLineageOnSuccessor: true, zeroImplementationZeroLedgerTasks: true, projectSkillCollisionNeverReachedModel: true,
    simulatedLocalOllamaHTTPOnly: true,
  })

  const skillMainWrite = report.scenarios.skillMainWrite
  expect(skillMainWrite.exitCode).toBe(0)
  expect(skillMainWrite.fixture).toMatchObject({
    exitCode: 0,
    runtimeCreateCount: 1,
    runtimeAdmissionCount: 1,
    turnInputs: ["/skill:pty-main-write create scope-write-target.txt"],
    turnCount: 1,
    runCount: 0,
    skillHomeIsolated: true,
    skillModelServer: { requests: 1, responses: 1, simulated: true },
    skillModelRequests: [{ model: "pty-fixture-model", hasSkillInstructions: true }],
    sourceChoices: [{ sessionID: "lca-pty-session", values: ["Allow this content in this session", "Deny"], answer: 0 }],
    toolPermissionChoices: [],
    writeFileContent: "FIXTURE_FILE_MUST_STAY_UNCHANGED\n",
  })
  expect(skillMainWrite.fixture.policyIDBefore).toBe(skillMainWrite.fixture.policyIDAfter)
  expect(skillMainWrite.fixture.planExecutionEvidence).toMatchObject([{
    ownerSession: "lca-pty-session", role: "main", policyID: skillMainWrite.fixture.policyIDBefore,
    kind: "host", hostDispatched: true, outcome: "failed", reconciled: true,
  }])
  expect(skillMainWrite.fixture.nativeToolActivities.filter(event => event.kind === "tool-started" || event.kind === "tool-finished").map(event => ({
    kind: event.kind, role: event.role, tool: event.tool, outcome: event.outcome, ok: event.ok,
  }))).toEqual([
    { kind: "tool-started", role: "main", tool: "write", outcome: undefined, ok: undefined },
    { kind: "tool-finished", role: "main", tool: "write", outcome: "denied", ok: false },
  ])
  expect(skillMainWrite.fixture.error).toBeUndefined()
  expect(skillMainWrite.capture).toMatchObject({ ...restoredTerminalProof, onlyResetSgr: true })
  expect(skillMainWrite.capture.modeProof).toMatchObject({
    settledFailureRetainsComposer: true,
    realPlanConversationAndExecutionIntent: true,
    fixedMainRoleDeniedWriteWithoutChooser: true,
    mainPolicyIDUnchanged: true,
    simulatedLocalOllamaHTTPOnly: true,
  })

  const toolActivities = report.scenarios.approve.fixture.toolActivityEvents
  expect(toolActivities).toEqual([
    { kind: "tool-started", role: "worker", execution: 1, taskID: "t1", executionID: "exec-fixture", callID: "call-fixture-1", tool: "read" },
    { kind: "tool-finished", role: "worker", execution: 1, taskID: "t1", executionID: "exec-fixture", callID: "call-fixture-1", tool: "read", outcome: "succeeded", ok: true },
    { kind: "tool-finished", role: "worker", execution: 1, taskID: "t1", executionID: "exec-fixture", callID: "call-fixture-1", tool: "read", outcome: "succeeded", ok: true },
    { kind: "tool-started", role: "worker", execution: 1, taskID: "t1", executionID: "exec-fixture", callID: "call-fixture-2", tool: "read" },
    { kind: "tool-finished", role: "worker", execution: 1, taskID: "t1", executionID: "exec-fixture", callID: "call-fixture-2", tool: "read", outcome: "failed", ok: false },
  ])
  expect(report.scenarios.approve.capture.modeProof).toMatchObject({
    toolItemsBeforeFilter: [
      "[+] #1 read · call succeeded · execution not observed · task Implement · t1",
      "[+] #2 read · call failed · execution not observed · task Implement · t1",
    ],
    expandedCallDetailVisible: true,
    searchReadFailedVisible: true,
    searchReadFailedMatchCount: 1,
    emptySearchRestoredBothTools: true,
  })

  const ctrlC = report.scenarios.ctrlCThresholds
  expect(ctrlC.exitCode).toBe(130)
  expect(ctrlC.fixture).toMatchObject({ exitCode: 130, turnCount: 0, decisionCount: 0, runCount: 0 })
  expect(ctrlC.capture).toMatchObject(restoredTerminalProof)
  expect(ctrlC.separatedClear.actualIntervalNanoseconds).toBeGreaterThan(500_000_000)
  expect(ctrlC.separatedClear.actualIntervalMs).toBeGreaterThan(ctrlC.separatedClear.thresholdMs)
  expect(ctrlC.separatedClear.thresholdMs).toBe(500)
  expect(ctrlC.separatedClear.relation).toBe("greater-than")
  expect(ctrlC.separatedClear).toMatchObject({ composerCleared: true, sessionRemainedRunning: true })
  expect(ctrlC.doubleExit.actualIntervalNanoseconds).toBeLessThan(500_000_000)
  expect(ctrlC.doubleExit.actualIntervalMs).toBeLessThan(ctrlC.doubleExit.thresholdMs)
  expect(ctrlC.doubleExit.thresholdMs).toBe(500)
  expect(ctrlC.doubleExit.relation).toBe("less-than")
  expect(ctrlC.doubleExit).toMatchObject({ firstCtrlCClearedComposer: true, exitCode: 130 })

  expect(report.scenarios.signals.SIGINT).toMatchObject({ exitCode: 130, capture: restoredTerminalProof })
  expect(report.scenarios.signals.SIGTERM).toMatchObject({ exitCode: 143, capture: restoredTerminalProof })
  expect(report.scenarios.signals.SIGHUP).toMatchObject({ exitCode: 129, capture: restoredTerminalProof })
  expect(report.scope).toContain("deterministic mock host/runtime")
  expect(report.scope).toContain("real skill broker/context with a deterministic loopback Ollama-compatible model stub")
  expect(report.coverage.notCovered).toContain("native skill tool-scope scenarios use deterministic simulated Ollama responses over loopback HTTP; no model inference is launched")
  expect(report.coverage.notCovered).toContain("skill scenario uses a deterministic conversation/model-transport stub; the installed external CLI stub is not launched")
  expect(report.coverage.notCovered).toContain("readline skill scenario uses the same deterministic model-turn and external CLI stubs; no inference is launched")
  expect(report.coverage.notCovered).toContain("PTY qualification applies only to the platform and terminal behavior recorded in this run; other operating systems and terminal emulators are not qualified")
  expect(report.coverage.notCovered).toContain("exact 499/500/501 ms Ctrl+C boundary values remain deterministic editor-unit coverage; PTY coverage records separated >500 ms clearing and paired <500 ms shutdown")
  expect(report.coverage.notCovered).toContain("physical PTY master-close terminal-disconnect HUP is not covered; SIGHUP is delivered explicitly with os.kill")
}, 150_000)
