import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation } from "../src/hosts/types.ts"
import type { Terminal } from "../src/hosts/interactive-session.ts"
import { attachAdmission, detachAdmission } from "../src/sessions/admission.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { consumeNativeSkillOptForegroundRunResult, createNativeSkillOptForeground } from "../src/skillopt/foreground.ts"
import { SkillOptBrokerError } from "../src/skillopt/broker.ts"
import { SkillOptControllerError } from "../src/skillopt/controller.ts"
import { NativeLoadVerificationError } from "../src/skillopt/load-verification.ts"
import { assembleSkill, canonicalJson, COMPILE_ANCHOR, PILOT_SKILL, sha256 } from "../src/skillopt/pilot.ts"
import {
  applySkillOptPromotion, nativePromotionArtifactBudget, nativePromotionMutationIsQuiescent, PromotionError,
  rollbackSkillOptPromotion, type PromotionCommon,
} from "../src/skillopt/promotion.ts"
import {
  classifyNativeSkillOptPublicationFailure, formatNativeSkillOptApprovalReviewForDisplay, rollbackPublishedNativeSkillOptRun,
} from "../src/skillopt/publication.ts"
import { tempWorktree } from "./guards-helpers.ts"

test("publication failure classification exposes only operation-scoped typed safe codes", () => {
  const privateMessage = "private /home/user/session-raw-error.txt"
  const applyPromotionFailure = new PromotionError("native-promotion-not-awaiting-load-witness", privateMessage)
  const rollbackPromotionFailure = new PromotionError("native-rollback-not-awaiting-load-witness", privateMessage)
  const generic = "publication_unresolved"

  expect(classifyNativeSkillOptPublicationFailure("apply", applyPromotionFailure))
    .toBe("native-promotion-not-awaiting-load-witness")
  expect(classifyNativeSkillOptPublicationFailure("apply", new NativeLoadVerificationError("native-load-canary-not-passed")))
    .toBe("native-load-canary-not-passed")
  expect(classifyNativeSkillOptPublicationFailure("rollback", rollbackPromotionFailure))
    .toBe("native-rollback-not-awaiting-load-witness")
  expect(classifyNativeSkillOptPublicationFailure("rollback", new SkillOptControllerError("rollback-canary-handoff-invalid")))
    .toBe("rollback-canary-handoff-invalid")
  expect(classifyNativeSkillOptPublicationFailure("rollback", new SkillOptBrokerError("execution_unresolved")))
    .toBe("execution_unresolved")

  expect(classifyNativeSkillOptPublicationFailure("rollback", applyPromotionFailure)).toBe(generic)
  expect(classifyNativeSkillOptPublicationFailure("apply", rollbackPromotionFailure)).toBe(generic)
  expect(classifyNativeSkillOptPublicationFailure("apply", new PromotionError(privateMessage))).toBe(generic)
  expect(classifyNativeSkillOptPublicationFailure("rollback", new PromotionError(privateMessage))).toBe(generic)
  expect(classifyNativeSkillOptPublicationFailure("apply", new Error(privateMessage))).toBe(generic)
  expect(classifyNativeSkillOptPublicationFailure("rollback", new Error(privateMessage))).toBe(generic)
  expect(classifyNativeSkillOptPublicationFailure("apply", { code: "native-promotion-not-awaiting-load-witness", message: privateMessage }))
    .toBe(generic)
  expect(classifyNativeSkillOptPublicationFailure("rollback", { code: "native-rollback-not-awaiting-load-witness", message: privateMessage }))
    .toBe(generic)

  const classified = [
    classifyNativeSkillOptPublicationFailure("apply", applyPromotionFailure),
    classifyNativeSkillOptPublicationFailure("rollback", new Error(privateMessage)),
  ]
  expect(JSON.stringify(classified)).not.toContain(privateMessage)
})

test("approval review renderer formats data only and does not create approval authority", () => {
  // Synthetic hash-bound display inputs only; no controller-issued qualification, native preview, human decision, or mutation exists here.
  const runId = randomUUID()
  const fragment = "private candidate insertion"
  const originalSkill = `---\nname: llm-wiki\ndescription: Private review display fixture\n---\n${COMPILE_ANCHOR}\n`
  const candidateSkill = assembleSkill(originalSkill, fragment)
  const originalSha256 = sha256(originalSkill)
  const candidateSha256 = sha256(candidateSkill)
  const insertedBytes = Buffer.from(`\n${fragment}\n\n`, "utf8")
  const targetRuntimeIdentity = { version: "runtime-version", executableSha256: "7".repeat(64) }
  const targetProfileIdentity = { id: "profile-id", sha256: "6".repeat(64) }
  const applyArtifactBudget = nativePromotionArtifactBudget("apply")
  const rollbackArtifactBudget = nativePromotionArtifactBudget("rollback")
  const bindings = {
    witnessMode: "native", runId, rootBinding: "c".repeat(64), sourceSha256: "d".repeat(64),
    originalSha256, candidateSha256, fixturePackSha256: "e".repeat(64), canaryFixtureSha256: "f".repeat(64),
    protocolSha256: "1".repeat(64), evaluatorSha256: "2".repeat(64), runtimeSha256: sha256(canonicalJson(targetRuntimeIdentity)),
    resultsSha256: "4".repeat(64), witnessSha256: "5".repeat(64), nativeEngine: "codex", nativeModel: "model-id",
    nativeProfileId: "profile-id", nativeProfileSha256: "6".repeat(64), nativeRuntimeVersion: "runtime-version",
    nativeExecutableSha256: "7".repeat(64),
  }
  const metrics = {
    schema: "skillopt.native-wiki-metrics.v1", status: "METRICS_PASSED" as const, reasons: [],
    packSha256: "e".repeat(64), baselineSha256: originalSha256, candidateSha256, protocolSha256: bindings.evaluatorSha256,
    trialsSha256: "8".repeat(64), requiredTrials: 12, observedTrials: 12, invalidTrials: 0,
    dev: { families: 2, trials: 6, baselineMean: 0.5, candidateMean: 0.75, gain: 0.5,
      baselineLatencyMs: 10, candidateLatencyMs: 11, latencyRatio: 1.1 },
    final: { families: 2, trials: 6, baselineMean: 0.4, candidateMean: 0.7, gain: 0.75,
      baselineLatencyMs: 12, candidateLatencyMs: 12, latencyRatio: 1 },
    confidenceInterval: { lower: 0.1, upper: 0.8 }, strata: {},
    safety: { requiredCandidateTrials: 3, passedCandidateTrials: 3 },
  }
  const resultsSha256 = sha256(canonicalJson(metrics))
  bindings.resultsSha256 = resultsSha256
  const reviewerEvidence = [
    { phase: "final", status: "valid", promptSha256: "a".repeat(64), responseSha256: "b".repeat(64), assessment: "clear", findings: [] },
    { phase: "safety", status: "valid", promptSha256: "c".repeat(64), responseSha256: "d".repeat(64), assessment: "clear", findings: [] },
  ]
  const reviewSha256 = sha256(canonicalJson(reviewerEvidence))
  bindings.witnessSha256 = sha256(canonicalJson({
    schema: "skillopt.native-qualified-candidate.v1", runId, bindingSha256: "b".repeat(64),
    candidateSha256, resultsSha256, reviewSha256,
  }))
  const status = {
    state: "AWAITING_CANDIDATE_APPROVAL", runId, revision: 4, pendingDispatch: false, quotaKeySha256: "9".repeat(64),
    requestCounts: { charged: { target: 5, optimizer: 1, reviewer: 2 }, dispatched: { target: 5, optimizer: 1, reviewer: 2 },
      unknown: { target: 1, optimizer: 0, reviewer: 0 } },
    targetPhaseCounts: {
      trainingAndDevelopment: { charged: 2, dispatched: 2, unknown: 1 },
      finalSafety: { charged: 2, dispatched: 2, unknown: 0 },
      canary: { charged: 0, dispatched: 0, unknown: 0 },
    },
    remaining: { target: 500, optimizer: 39, reviewer: 0, activeMilliseconds: 1000,
      artifactBytes: applyArtifactBudget.approvalBytes + applyArtifactBudget.transactionBytes + applyArtifactBudget.witnessBytes,
      candidateSteps: 0 },
    dailyCooldownRemainingMilliseconds: 0,
  }
  const ownerSessionID = `session_${randomUUID().replaceAll("-", "")}`
  const ownerEpoch = randomUUID()
  const qualification = {
    runId, bindingSha256: "b".repeat(64), scheduleSha256: "c".repeat(64), baselineSkillSha256: originalSha256,
    candidateSha256, resultsSha256, reviewSha256,
    ownerSessionHash: sha256(ownerSessionID), ownerEpochHash: sha256(ownerEpoch), admissionHash: "3".repeat(64),
    expiresBoot: randomUUID(), expiresContinuousNanoseconds: "1000000", expiresWallMilliseconds: "1800000000000",
    remainingCanaryRequests: 16,
  }
  const snapshot = (operation: "apply" | "rollback") => ({
    operation, runId, targetPath: "/private/worktree/.agents/skills/llm-wiki/SKILL.md",
    targetRelativePath: ".agents/skills/llm-wiki/SKILL.md", rootBinding: bindings.rootBinding,
    worktree: { path: "/private/worktree", stat: ["1", "2"] },
    targetParent: { path: "/private/worktree/.agents/skills/llm-wiki", dev: "1", ino: "2", mode: 0o700 },
    agentsDirectory: ["1", "2"], skillsDirectory: ["1", "2"],
    transactionRoot: { path: "/private/worktree/.state/promotion", dev: "1", ino: "2", mode: 0o700 },
    bindings, bindingsSha256: sha256(canonicalJson(bindings)),
    target: { sha256: operation === "apply" ? originalSha256 : candidateSha256 },
    candidateSha256, candidateBytes: Buffer.byteLength(candidateSkill), backup: { sha256: originalSha256 },
    ...(operation === "rollback" ? {
      latestState: "COMMITTED", latestJournalSeq: 8, latestJournalChecksum: "1".repeat(64),
      applyJournalSha256: "2".repeat(64), manifestSha256: "3".repeat(64), applyApprovalSha256: "5".repeat(64),
      displacedOriginal: { sha256: originalSha256 },
    } : {
      qualificationSha256: "6".repeat(64), reviewSha256: "7".repeat(64), semanticReviewSha256: reviewSha256,
      qualificationPath: "/private/evidence/qualification.json", reviewPath: "/private/evidence/review.json",
    }),
  })
  const makeSubject = (operation: "apply" | "rollback") => ({
    schema: "skillopt.native-operator-subject.v1", operation,
    action: operation === "apply" ? "approve-production-apply" : "approve-production-rollback",
    snapshot: snapshot(operation),
    ownerPrincipal: {
      sessionID: ownerSessionID, epoch: ownerEpoch,
      admission: { sessionID: ownerSessionID, epoch: ownerEpoch, leaseId: "sample-lease" },
      metadata: { engine: "codex", model: "gpt-5-codex", routes: null },
    },
    ownerSessionID, ownerEpoch, nativeBootId: "sample-boot-id",
    createdContinuousNanoseconds: "100000", expiresContinuousNanoseconds: "1000000",
    expiresWallMilliseconds: "1800000000000", runDeadlineAt: 1800000000000,
  })
  const details = makeSubject("apply")
  const applySubjectSha256 = sha256(canonicalJson(details))
  const anchorOffset = originalSkill.indexOf(COMPILE_ANCHOR) + COMPILE_ANCHOR.length
  const reviewDiff = {
    fragment, insertedBytes,
    protectedPrefixBytes: Buffer.byteLength(originalSkill.slice(0, anchorOffset)),
    protectedPrefixSha256: sha256(Buffer.from(originalSkill.slice(0, anchorOffset), "utf8")),
    protectedSuffixBytes: Buffer.byteLength(originalSkill.slice(anchorOffset)),
    protectedSuffixSha256: sha256(Buffer.from(originalSkill.slice(anchorOffset), "utf8")),
    prefixUnchanged: true, suffixUnchanged: true, exactReassembly: true,
  }
  const rendered = formatNativeSkillOptApprovalReviewForDisplay({
    operation: "apply", runId, decisionSubjectSha256: applySubjectSha256, details,
    bindingSha256: "b".repeat(64), qualification, reviewSha256: qualification.reviewSha256,
    bindings, candidateByteLength: Buffer.byteLength(candidateSkill),
    dataset: {
      datasetSha256: "c".repeat(64), sourceExportSha256: "d".repeat(64), fixturePackSha256: "e".repeat(64),
      protocolSha256: bindings.protocolSha256, sourceManifest: { manifestSha256: "9".repeat(64) }, trainerProjectionSha256: null,
      modelBindings: {
        target: { engine: "codex", requestedModel: "model-id", runtimeIdentity: targetRuntimeIdentity,
          profileIdentity: targetProfileIdentity },
        generator: { engine: "claude", requestedModel: "generator-model",
          runtimeIdentity: { version: "generator-runtime", executableSha256: "a".repeat(64) },
          profileIdentity: { id: "generator-profile", sha256: "b".repeat(64) } },
        reviewer: { engine: "claude", requestedModel: "reviewer-model",
          runtimeIdentity: { version: "reviewer-runtime", executableSha256: "c".repeat(64) },
          profileIdentity: { id: "reviewer-profile", sha256: "d".repeat(64) } },
      },
      fixturePack: {
        privateSourceBody: "private fixture source body",
        privateGoldAssertion: "private gold assertion body",
        privateReviewerModelResponse: "private raw reviewer/model response",
      },
    },
    metrics, status, providerTokenMaximumEnforced: false, artifactBudget: applyArtifactBudget, canaryReserve: 16,
    diff: reviewDiff,
  } as never)
  expect(rendered).toContain(`candidate diff: + ${JSON.stringify(fragment)}`)
  expect(rendered).toContain("family 수=2")
  expect(rendered).toContain("전체 confidence interval=[0.1000, 0.8000]")
  expect(rendered).toContain("invalid trial=0")
  expect(rendered).toContain("미관측 trial=0")
  expect(rendered).toContain("target=1")
  expect(rendered).toContain("target=500/512")
  expect(rendered).toContain("artifact reservation upper bound (not disk-byte measurement)")
  expect(rendered).toContain(`projected after precharge=${applyArtifactBudget.witnessBytes}`)
  expect(rendered).toContain(applySubjectSha256)
  expect(rendered).toContain(resultsSha256)
  expect(rendered).toContain(reviewSha256)
  expect(rendered).toContain(`보호된 prefix bytes=${reviewDiff.protectedPrefixBytes}`)
  expect(rendered).toContain(`protected suffix bytes=${reviewDiff.protectedSuffixBytes}`)
  expect(rendered).not.toContain("private fixture source body")
  expect(rendered).not.toContain("private gold assertion body")
  expect(rendered).not.toContain("private raw reviewer/model response")
  expect(rendered).not.toContain("/private/worktree")

  const rollbackDetails = makeSubject("rollback")
  const rollbackSubjectSha256 = sha256(canonicalJson(rollbackDetails))
  const rollbackStatus = { ...status, state: "COMPLETED" as const }
  const rollbackRendered = formatNativeSkillOptApprovalReviewForDisplay({
    operation: "rollback", runId, decisionSubjectSha256: rollbackSubjectSha256,
    bindingSha256: "b".repeat(64), qualification, reviewSha256: qualification.reviewSha256,
    bindings, candidateByteLength: Buffer.byteLength(candidateSkill),
    details: rollbackDetails,
    dataset: {
      datasetSha256: "c".repeat(64), sourceExportSha256: "d".repeat(64), fixturePackSha256: "e".repeat(64),
      protocolSha256: bindings.protocolSha256, sourceManifest: { manifestSha256: "9".repeat(64) }, trainerProjectionSha256: null,
      modelBindings: {
        target: { engine: "codex", requestedModel: "model-id", runtimeIdentity: targetRuntimeIdentity,
          profileIdentity: targetProfileIdentity },
        generator: { engine: "claude", requestedModel: "generator-model",
          runtimeIdentity: { version: "generator-runtime", executableSha256: "a".repeat(64) },
          profileIdentity: { id: "generator-profile", sha256: "b".repeat(64) } },
        reviewer: { engine: "claude", requestedModel: "reviewer-model",
          runtimeIdentity: { version: "reviewer-runtime", executableSha256: "c".repeat(64) },
          profileIdentity: { id: "reviewer-profile", sha256: "d".repeat(64) } },
      },
    },
    metrics, status: rollbackStatus, providerTokenMaximumEnforced: false,
    artifactBudget: rollbackArtifactBudget, canaryReserve: 16,
    diff: reviewDiff,
    applyApprovalSha256: "5".repeat(64),
  } as never)
  expect(rollbackRendered).toContain(`rollback diff: - ${JSON.stringify(fragment)}`)
  expect(rollbackRendered).toContain("복원할 original=")
  expect(rollbackRendered).toContain(`기존 apply journal=${"2".repeat(64)}`)
  expect(rollbackRendered).toContain(`새 rollback 승인 subject=${rollbackSubjectSha256}`)
  expect(rollbackRendered).toContain(resultsSha256)
  expect(rollbackRendered).toContain(reviewSha256)
  expect(rollbackRendered).not.toContain("/private/worktree")
})

test("native mutation settlement accepts only the exact observed terminal outcome", async () => {
  const common = {
    targetPath: "/unused/publication-target",
    transactionRoot: "/unused/publication-transactions",
    nativeHelperPath: "/unused/native-helper",
    nativeHelperSha256: "a".repeat(64),
    bindings: { witnessMode: "native", runId: randomUUID() },
  } as unknown as PromotionCommon
  const observedError = await applySkillOptPromotion({
    ...common,
    candidateBytes: Buffer.from("not a qualified candidate"),
    evidence: {
      qualification: { path: "/unused/qualification", sha256: "b".repeat(64) },
      review: { path: "/unused/review", sha256: "c".repeat(64) },
      approval: { path: "/unused/approval", sha256: "d".repeat(64) },
    },
    verifyEvidence: async () => {},
  }).catch(error => error)
  expect(observedError).toBeInstanceOf(Error)
  expect(observedError).toMatchObject({ code: "native-authorization-required" })
  expect(nativePromotionMutationIsQuiescent(observedError, common, "apply")).toBe(true)
  const observedCopy = JSON.parse(JSON.stringify(observedError)) as unknown
  expect(nativePromotionMutationIsQuiescent(observedCopy, common, "apply")).toBe(false)
  expect(nativePromotionMutationIsQuiescent(observedError, common, "rollback")).toBe(false)
  const otherCommon = { ...common, transactionRoot: "/unused/other-transactions" }
  expect(nativePromotionMutationIsQuiescent(observedError, otherCommon, "apply")).toBe(false)
  expect(nativePromotionMutationIsQuiescent("native-authorization-required", common, "apply")).toBe(false)

  const observedRollbackError = await rollbackSkillOptPromotion(common).catch(error => error)
  expect(observedRollbackError).toBeInstanceOf(Error)
  expect(observedRollbackError).toMatchObject({ code: "native-authorization-required" })
  expect(nativePromotionMutationIsQuiescent(observedRollbackError, common, "rollback")).toBe(true)
  expect(nativePromotionMutationIsQuiescent(observedRollbackError, common, "apply")).toBe(false)
  const copiedRollbackError = JSON.parse(JSON.stringify(observedRollbackError)) as unknown
  expect(nativePromotionMutationIsQuiescent(copiedRollbackError, common, "rollback")).toBe(false)

  const returnedShape = Object.freeze({ state: "SWAPPED_EXPECTED", idempotent: false,
    raceMayHavePublishedCandidate: false })
  const copied = JSON.parse(JSON.stringify(returnedShape)) as unknown
  expect(nativePromotionMutationIsQuiescent(returnedShape, common, "apply")).toBe(false)
  expect(nativePromotionMutationIsQuiescent(copied, common, "apply")).toBe(false)
  expect(nativePromotionMutationIsQuiescent("SWAPPED_EXPECTED", common, "apply")).toBe(false)
  expect(nativePromotionMutationIsQuiescent("RACE_HELD", common, "rollback")).toBe(false)
  expect(nativePromotionMutationIsQuiescent(returnedShape, common, "rollback")).toBe(false)
})

test("a serialized or forged qualification cannot publish and leaves the target untouched", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  const original = Buffer.from("# llm-wiki\n\nPublication test baseline.\n", "utf8")
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, original, { mode: 0o600 })
  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) { throw new Error("publication test must not dispatch") },
    async reconcile(): Promise<ExecutionReconciliation> {
      return { outcome: "unknown", quiescent: false, evidence: "publication test creates no executions" }
    },
  }
  const runtime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} },
    () => host, { planningOnlyMain: true })
  const competingRuntime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} },
    () => host, { planningOnlyMain: true })
  const owner = attachAdmission(runtime, `session_${randomUUID().replaceAll("-", "")}`, {
    engine: "codex", model: "gpt-5-codex",
  })
  const service = createNativeSkillOptForeground(runtime, owner)
  const runId = randomUUID()
  const fakeReceipt = JSON.parse(JSON.stringify({ runId, state: "AWAITING_CANDIDATE_APPROVAL",
    candidate: { skill: "private candidate content" }, reviewerEvidence: [{ responseSha256: "f".repeat(64) }] })) as object
  const terminal: Terminal = { stdinIsTTY: true, stderrIsTTY: true, readLine: async () => undefined, write() {}, close() {} }
  try {
    const mutationClaim = runtime.runs.claim(owner.sessionID, `skillopt-publication-test-${randomUUID()}`, process.pid)
    try {
      expect(() => runtime.runs.claim(owner.sessionID, `skillopt-competing-test-${randomUUID()}`, process.pid)).toThrow()
      expect(() => competingRuntime.runs.claim(owner.sessionID, `skillopt-second-store-${randomUUID()}`, process.pid)).toThrow()
      expect(() => runtime.runs.assertQuiescent({ ...mutationClaim, token: `${mutationClaim.token}-forged` })).toThrow()
      expect(() => runtime.runs.assertQuiescent({ ...mutationClaim, ownerSession: `session_${randomUUID().replaceAll("-", "")}` })).toThrow()
      expect(() => competingRuntime.runs.claim(owner.sessionID, `skillopt-second-store-after-forgery-${randomUUID()}`, process.pid)).toThrow()
      const claimedStatus = runtime.runs.status()
      expect(claimedStatus.claim).toMatchObject({ ownerSession: owner.sessionID, instance: mutationClaim.instance })
      expect(JSON.stringify(claimedStatus)).not.toContain(mutationClaim.token)
    } finally {
      runtime.runs.assertQuiescent(mutationClaim)
      runtime.runs.release(mutationClaim)
    }
    expect(() => consumeNativeSkillOptForegroundRunResult(fakeReceipt, owner, runtime))
      .toThrow("foreground_run_receipt_invalid")
    const absentRollback = await rollbackPublishedNativeSkillOptRun({ data: fakeReceipt } as never)
    expect(absentRollback).toMatchObject({ operation: "rollback", state: "BLOCKED", candidateQualified: false,
      publicationAuthorized: false, rollbackAuthorized: false, reasonCode: "published_context_unavailable" })
    const result = await service.publish(runId, terminal)
    expect(result).toMatchObject({ operation: "publish", state: "BLOCKED", reasonCode: "qualified_run_receipt_unavailable",
      candidateQualified: false, publicationAuthorized: false, postApplyHandoffAuthorized: false })
    expect(JSON.stringify(result)).not.toContain("private candidate content")
    expect(sha256(readFileSync(skillPath))).toBe(sha256(original))
    expect(existsSync(join(executionRunDirectory(root), "skillopt-native-promotion", runId))).toBe(false)
  } finally {
    service.dispose()
    if (!owner.isReleased) await detachAdmission(runtime, owner.sessionID, owner.epoch, "publication_test_complete")
    worktree.cleanup()
  }
})
