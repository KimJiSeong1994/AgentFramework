#!/usr/bin/env bun
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { COMBO_PRESETS } from "../framework/src/hosts/combo-presets.ts"
import type { Terminal } from "../framework/src/hosts/interactive-session.ts"
import { terminalSafeText } from "../framework/src/hosts/terminal-text.ts"
import type { SkillOptForegroundInput, SkillOptForegroundService } from "../framework/src/skillopt/foreground.ts"
import { inspectPilotCapability } from "../framework/src/skillopt/host.ts"
import { canonicalJson, sha256, SkillOptError, snapshotSources } from "../framework/src/skillopt/pilot.ts"

const LEGACY_USAGE = "Usage: bun scripts/otter-skillopt.ts <snapshot|preflight> [--root DIR]"
const FOREGROUND_USAGE = "사용법: bun scripts/otter-skillopt.ts <prepare|status|consent|arm|disarm|cancel|resume|run> [--root DIR] [--input FILE] [--run ID]\n       bun scripts/otter-skillopt.ts cleanup [--root DIR] --run ID (no --input)"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const bundledDefaultModel = COMBO_PRESETS[0]!.main
const [command, ...args] = process.argv.slice(2)

function publicForegroundMetadata(operation: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { operation, state: "BLOCKED" }
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = { operation }
  for (const key of ["state", "controllerState", "metricsStatus"] as const) {
    const item = record[key]
    if (typeof item === "string" && /^[A-Z_]{1,48}$/u.test(item)) result[key] = item
  }
  if (typeof record.reasonCode === "string" && /^[a-z0-9][a-z0-9_:-]{0,95}$/iu.test(record.reasonCode)) {
    result.reasonCode = record.reasonCode
  }
  if (typeof record.runId === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(record.runId)) result.runId = record.runId
  for (const key of ["revision", "reviewerCount", "targetRequests", "canaryReserve", "targetRequestCap",
    "consentExpiresAtMilliseconds", "armExpiresAtMilliseconds", "dailyCooldownRemainingMilliseconds"] as const) {
    const item = record[key]
    if (Number.isSafeInteger(item) && (item as number) >= 0) result[key] = item
  }
  for (const key of ["pendingDispatch", "cancelled", "retainedUnresolvedExecution", "candidateQualified",
    "publicationAuthorized", "postApplyHandoffAuthorized", "modelExecutionStarted", "dispatchStarted",
    "optimizationSucceeded"] as const) {
    const item = record[key]
    if (typeof item === "boolean") result[key] = item
  }
  for (const key of ["bindingSha256", "datasetSha256", "sourceExportSha256", "fixturePackSha256",
    "modelBindingsSha256", "protocolSha256", "baselineSkillSha256", "scheduleSha256", "inputArtifactSha256",
    "digestWatermarkSha256", "candidateSha256"] as const) {
    const item = record[key]
    if (typeof item === "string" && /^[a-f0-9]{64}$/u.test(item)) result[key] = item
  }
  if (Array.isArray(record.requirements)) {
    result.requirements = record.requirements.slice(0, 16)
      .filter((item): item is string => typeof item === "string" && /^[a-z0-9_-]{1,80}$/u.test(item))
  }
  for (const group of ["charged", "dispatched", "unknown"] as const) {
    const counts = record.requestCounts
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) break
    const values = (counts as Record<string, unknown>)[group]
    if (!values || typeof values !== "object" || Array.isArray(values)) continue
    const roles = values as Record<string, unknown>
    const safeRoles: Record<string, number> = {}
    for (const role of ["target", "optimizer", "reviewer"] as const) {
      const count = roles[role]
      if (Number.isSafeInteger(count) && (count as number) >= 0) safeRoles[role] = count as number
    }
    if (Object.keys(safeRoles).length) {
      const safeCounts = (result.requestCounts ??= {}) as Record<string, unknown>
      safeCounts[group] = safeRoles
    }
  }
  if (record.remaining && typeof record.remaining === "object" && !Array.isArray(record.remaining)) {
    const remaining = record.remaining as Record<string, unknown>
    const safeRemaining: Record<string, number> = {}
    for (const key of ["target", "optimizer", "reviewer", "activeMilliseconds", "artifactBytes", "candidateSteps"] as const) {
      const count = remaining[key]
      if (Number.isSafeInteger(count) && (count as number) >= 0) safeRemaining[key] = count as number
    }
    if (Object.keys(safeRemaining).length) result.remaining = safeRemaining
  }
  return result
}

function printForegroundMetadata(operation: string, value: unknown): void {
  console.log(JSON.stringify(publicForegroundMetadata(operation, value)))
}

function usageError(message = FOREGROUND_USAGE): never {
  console.error(message)
  process.exit(2)
}

function parseOptions(options: Record<string, { type: "string" }>) {
  try { return parseArgs({ args, allowPositionals: false, strict: true, options }) }
  catch { return undefined }
}

function runLegacy(command: "snapshot" | "preflight"): void {
  const parsed = parseOptions({ root: { type: "string" } })
  if (!parsed) usageError(LEGACY_USAGE)
  const rootValue = parsed.values.root
  if (rootValue !== undefined && typeof rootValue !== "string") usageError(LEGACY_USAGE)
  const root = resolve(rootValue ?? resolve(import.meta.dir, ".."))
  try {
    const snapshot = snapshotSources(root)
    const snapshotSha256 = sha256(canonicalJson(snapshot))
    if (command === "snapshot") {
      console.log(JSON.stringify({ snapshotSha256, snapshot }, null, 2))
    } else {
      const capability = inspectPilotCapability()
      console.log(JSON.stringify({ snapshotSha256, originalSkillSha256: snapshot.originalSkillSha256, capability }, null, 2))
      process.exitCode = 1
    }
  } catch (error) {
    console.error(JSON.stringify({ status: "blocked", code: error instanceof SkillOptError ? error.code : "preflight_failed", experimentAdmitted: false, productionApplied: false }))
    process.exitCode = 1
  }
}

function dataRequired(reasonCode: string, requirements: readonly string[] = []): void {
  console.log(JSON.stringify({ state: "DATA_REQUIRED", reasonCode, requirements,
    message: "필수 자료가 필요합니다.", optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false }))
  process.exitCode = 1
}

async function runForeground(): Promise<void> {
  if (!command || !["prepare", "status", "consent", "arm", "disarm", "cancel", "resume", "run", "cleanup"].includes(command)) usageError()
  const parsed = parseOptions({ root: { type: "string" }, input: { type: "string" }, run: { type: "string" } })
  if (!parsed) usageError()
  const rootValue = parsed.values.root
  const inputPath = parsed.values.input
  const runId = parsed.values.run
  if ((rootValue !== undefined && typeof rootValue !== "string") || (inputPath !== undefined && typeof inputPath !== "string") ||
      (runId !== undefined && (typeof runId !== "string" || !UUID.test(runId)))) usageError()
  if (command === "cleanup" && inputPath !== undefined) {
    usageError("Usage: bun scripts/otter-skillopt.ts cleanup [--root DIR] --run ID (no --input)")
  }
  if (command === "prepare" && runId !== undefined || command !== "prepare" && command !== "status" && runId === undefined ||
      command === "status" && inputPath !== undefined) usageError()
  const root = resolve(rootValue ?? resolve(import.meta.dir, ".."))
  const [{ createCliRuntime }, { attachAdmission, detachAdmission }, foreground] = await Promise.all([
    import("../framework/src/hosts/cli-runtime.ts"), import("../framework/src/sessions/admission.ts"),
    import("../framework/src/skillopt/foreground.ts"),
  ])

  if (command === "status") {
    const runtime = createCliRuntime({ worktree: root, engine: bundledDefaultModel.engine, model: bundledDefaultModel.model })
    const sessionID = `session_${randomUUID().replaceAll("-", "")}`
    const owner = attachAdmission(runtime, sessionID, { engine: bundledDefaultModel.engine, model: bundledDefaultModel.model })
    let service: SkillOptForegroundService | undefined
    let disposeError: unknown
    try {
      const activeService = foreground.createNativeSkillOptForeground(runtime, owner)
      service = activeService
      const status = activeService.status()
      if (runId !== undefined && status.runId !== runId) {
        console.log(JSON.stringify({ status: "BLOCKED", reasonCode: "run_stale", optimizationSucceeded: false,
          message: "요청한 run이 현재 controller 상태와 일치하지 않습니다." }))
        process.exitCode = 1
        return
      }
      console.log(JSON.stringify({ status: status.state, runId: status.runId, reasonCode: status.reasonCode,
        revision: status.revision, pendingDispatch: status.pendingDispatch, requestCounts: status.requestCounts,
        targetPhaseCounts: status.targetPhaseCounts, remaining: status.remaining,
        dailyCooldownRemainingMilliseconds: status.dailyCooldownRemainingMilliseconds,
        optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false,
        message: "상태 조회는 최적화 성공이나 실행 완료를 뜻하지 않습니다." }))
    } finally {
      try { service?.dispose() } catch (error) { disposeError = error }
      const detached = await detachAdmission(runtime, sessionID, owner.epoch, "skillopt_foreground_cli_exit")
      if (disposeError || !detached) throw new Error("owner_release_unproven")
    }
    return
  }

  if (command === "cleanup") {
    const runtime = createCliRuntime({ worktree: root, engine: bundledDefaultModel.engine, model: bundledDefaultModel.model })
    const sessionID = `session_${randomUUID().replaceAll("-", "")}`
    const owner = attachAdmission(runtime, sessionID, { engine: bundledDefaultModel.engine, model: bundledDefaultModel.model })
    let service: SkillOptForegroundService | undefined
    let disposeError: unknown
    const abortController = new AbortController()
    const abortOnInterrupt = () => abortController.abort()
    process.once("SIGINT", abortOnInterrupt)
    try {
      const activeService = foreground.createNativeSkillOptForeground(runtime, owner)
      service = activeService
      const result = await activeService.cleanup(runId!, abortController.signal)
      printForegroundMetadata("cleanup", result)
      if (result.state !== "CLEANED") process.exitCode = 1
    } finally {
      process.off("SIGINT", abortOnInterrupt)
      try { service?.dispose() } catch (error) { disposeError = error }
      const detached = await detachAdmission(runtime, sessionID, owner.epoch, "skillopt_foreground_cli_exit")
      if (disposeError || !detached) throw new Error("owner_release_unproven")
    }
    return
  }

  let input: SkillOptForegroundInput | undefined
  let expectedBindingSha256: string | undefined
  if (inputPath !== undefined) input = foreground.readSkillOptForegroundInput(inputPath)
  else if (command !== "prepare" && command !== "cancel") {
    if (!runId) usageError()
    try {
      const artifact = foreground.readSkillOptForegroundArtifact(root, runId)
      input = artifact.input
      expectedBindingSha256 = artifact.bindingSha256
    } catch (error) {
      if (error instanceof foreground.SkillOptForegroundError && error.code === "artifact_unavailable") {
        dataRequired("input_required")
        return
      }
      throw error
    }
  } else if (command === "cancel") {
    input = undefined
  } else {
    dataRequired("input_required")
    return
  }
  if (input) {
    const readiness = foreground.foregroundFixtureReadiness(input)
    if (readiness.state === "DATA_REQUIRED") {
      dataRequired(readiness.reasonCode ?? "fixture_pack_data_required", readiness.requirements)
      return
    }
    if (!input.selections?.length) {
      dataRequired("source_selection_required")
      return
    }
  }

  const { engine, model } = input?.models.generator ?? bundledDefaultModel
  const runtime = createCliRuntime({ worktree: root, engine, model })
  const sessionID = `session_${randomUUID().replaceAll("-", "")}`
  const owner = attachAdmission(runtime, sessionID, { engine, model })
  let service: SkillOptForegroundService | undefined
  let disposeError: unknown
  const abortController = new AbortController()
  const abortOnInterrupt = () => abortController.abort()
  process.once("SIGINT", abortOnInterrupt)
  try {
    const activeService = foreground.createNativeSkillOptForeground(runtime, owner)
    service = activeService
    const signal = abortController.signal
    const result = command === "prepare" ? await activeService.prepare(input, signal)
      : command === "consent" ? await activeService.consent(runId!, input, expectedBindingSha256, signal)
        : command === "arm" ? await activeService.arm(runId!, input, expectedBindingSha256, signal)
          : command === "disarm" ? await activeService.disarm(runId!, input, expectedBindingSha256, signal)
            : command === "cancel" ? await activeService.cancel(runId!, input, expectedBindingSha256, signal)
              : command === "resume" ? await activeService.resume(runId!, input, expectedBindingSha256, signal)
                : await activeService.run(runId!, input, expectedBindingSha256, signal)
    printForegroundMetadata(command, result)
    if (command === "run") {
      if (result.state === "AWAITING_CANDIDATE_APPROVAL" && result.candidateQualified === true && !signal.aborted) {
        const { createReadlineTerminal } = await import("../framework/src/hosts/interactive-session.ts")
        let terminal: Terminal | undefined
        try {
          terminal = createReadlineTerminal()
          const originalWrite = terminal.write
          let publication: Readonly<Record<string, unknown>>
          terminal.write = text => { process.stderr.write(terminalSafeText(text)) }
          try {
            publication = await activeService.publish(runId!, terminal, signal)
          } finally {
            terminal.write = originalWrite
          }
          printForegroundMetadata("publish", publication)
          if (publication.state !== "COMMITTED" || publication.publicationAuthorized !== true ||
              publication.postApplyHandoffAuthorized !== true) process.exitCode = 1
        } finally {
          terminal?.close()
        }
      } else {
        process.exitCode = 1
      }
    } else if (result.state === "DATA_REQUIRED") {
      process.exitCode = 1
    }
  } finally {
    process.off("SIGINT", abortOnInterrupt)
    try { service?.dispose() } catch (error) { disposeError = error }
    const detached = await detachAdmission(runtime, sessionID, owner.epoch, "skillopt_foreground_cli_exit")
    if (disposeError || !detached) throw new Error("owner_release_unproven")
  }
}

if (command === "snapshot" || command === "preflight") {
  runLegacy(command)
} else {
  try { await runForeground() }
  catch (error) {
    const { foregroundReasonCode } = await import("../framework/src/skillopt/foreground.ts")
    console.error(JSON.stringify({ status: "BLOCKED", reasonCode: foregroundReasonCode(error),
      message: "요청을 안전하게 처리하지 못했습니다.", optimizationSucceeded: false, dispatchStarted: false }))
    process.exitCode = 1
  }
}
