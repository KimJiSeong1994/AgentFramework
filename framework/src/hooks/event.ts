// event hook: (a) runaway-generation guard on streaming assistant text, (b) tool outcomes/error bookkeeping,
// (c) session.compacted -> lastCompactedAt, (d) session.idle -> continuation loop. Never throws (a rejection here
// would surface as a defect inside OpenCode's bus subscriber).
import type { Hooks } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import { enabled, type HookDeps } from "./types.ts"
import { readModeState, writeJsonAtomic, writeModeState } from "../state/store.ts"
import { getGuards } from "../guards/registry.ts"
import { abortPath, createIdleLoop } from "../loop/idle.ts"
import { getQueue } from "../orchestration/queue.ts"
import { recordToolOutcome } from "../telemetry/outcomes.ts"
import { clearToolObservations, readToolObservations, recordToolObservation, type ToolObservationResult } from "../hosts/tool-observation.ts"
import { observeStopSettlement, onCancelSettled, requestStop } from "../flow/runtime.ts"
import { readWorkflow, workflowEngineRefusal } from "../flow/state.ts"
import { TERMINAL } from "../workflows/types.ts"
import { flowOn } from "../flow/status.ts"
import { observeSkillMessage, observeSkillPart, observeRelatedToolPart, observeSkillBoundary } from "../telemetry/skill-observer.ts"
import { getOpenCodeRuntime, policyForOpenCodeSession } from "../hosts/opencode-runtime.ts"
import { completeOpenCodeToolCall, currentOpenCodeToolCall, openCodeToolCallArgumentsMatch, type OpenCodeToolCall } from "../hosts/opencode-tool-call.ts"
import { settled, type ExecutionRecord } from "../hosts/run-state.ts"
import { admissionEpoch, endAdmission, holdAdmission, isAdmissionCurrent } from "../sessions/admission.ts"
import { getOwnedSession } from "../sessions/store.ts"
import {
  captureForMessage, captureSDKMessage, captureSDKSessionCreationObservation, captureSDKSessionIdentity, captureSDKSessionLifetime,
  captureSDKSessionOwner, captureSDKTextPart, capturedSDKMessage as readCapturedSDKMessage,
  authenticatedSDKSessionIdentity, capturedSDKSessionDeletionEpoch, capturedSDKSessionOwner,
  registerPendingSDKSessionCreation,
  persistCompletedAssistantMessage, persistSDKMainToolFact, persistSDKToolFact,
} from "../sessions/sdk-transcript.ts"

const MAX_TRACKED_CALLS = 200

export function createEventHook(deps: HookDeps): NonNullable<Hooks["event"]> {
  const guards = getGuards(deps)
  const repetitionOn = enabled(deps.config, "guard.repetition")
  const repeatOn = enabled(deps.config, "guard.repeat")
  const toolHistoryOn = enabled(deps.config, "tool.history")
  const idle = createIdleLoop(deps)
  const runtime = getOpenCodeRuntime(deps)
  const queue = getQueue(runtime)

  /** parts already aborted for repetition */
  const abortedParts = new Set<string>()
  /** Uncorrelated tool errors whose callback key could not be stored in the observation registry. */
  const failedCalls = new Set<string>()
  /** Prevent duplicate deletion callbacks from acting on a later same-SID attachment. */
  const deletedSessions = new Map<string, string>()

  async function captureAuthenticatedChildOwner(sessionID: string): Promise<void> {
    let identity = authenticatedSDKSessionIdentity(deps.worktree, sessionID)
    if (!identity) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionID)) return
      const storeBefore = getOwnedSession(deps.worktree, sessionID)
      const epochBefore = admissionEpoch(deps.worktree, sessionID)
      const lookup = await deps.client.session.get({ path: { id: sessionID }, query: { directory: deps.directory } })
      const vendor = lookup.data as { id?: unknown; directory?: unknown; parentID?: unknown; time?: { created?: unknown; updated?: unknown } } | undefined
      const canonicalWorktree = canonicalDirectory(deps.worktree)
      const expectedDirectory = canonicalDirectory(deps.directory)
      const vendorDirectory = canonicalDirectory(vendor?.directory)
      const directoryFromWorktree = canonicalWorktree && expectedDirectory ? relative(canonicalWorktree, expectedDirectory) : undefined
      if (lookup.error || !vendor || vendor.id !== sessionID || !canonicalWorktree || !expectedDirectory ||
          directoryFromWorktree === undefined || directoryFromWorktree === ".." || directoryFromWorktree.startsWith(`..${sep}`) ||
          isAbsolute(directoryFromWorktree) || vendorDirectory !== expectedDirectory ||
          typeof vendor.time?.created !== "number" || !Number.isFinite(vendor.time.created) || vendor.time.created < 0 ||
          typeof vendor.time.updated !== "number" || !Number.isFinite(vendor.time.updated) || vendor.time.updated < 0 ||
          getOwnedSession(deps.worktree, sessionID) !== storeBefore || admissionEpoch(deps.worktree, sessionID) !== epochBefore) return
      if (vendor.parentID !== undefined) return
      if (!captureSDKSessionIdentity(deps.worktree, sessionID, {
        directory: expectedDirectory,
        createdAt: vendor.time.created,
        updatedAt: vendor.time.updated,
      })) return
      identity = authenticatedSDKSessionIdentity(deps.worktree, sessionID)
    }
    const canonicalWorktree = canonicalDirectory(deps.worktree)
    const expectedDirectory = canonicalDirectory(deps.directory)
    const directoryFromWorktree = canonicalWorktree && expectedDirectory ? relative(canonicalWorktree, expectedDirectory) : undefined
    if (!identity || !canonicalWorktree || !expectedDirectory || identity.directory !== expectedDirectory ||
        directoryFromWorktree === undefined || directoryFromWorktree === ".." || directoryFromWorktree.startsWith(`..${sep}`) ||
        isAbsolute(directoryFromWorktree)) return
    if (!identity.parentID) {
      const store = getOwnedSession(deps.worktree, sessionID)
      const epoch = admissionEpoch(deps.worktree, sessionID)
      if (store && epoch && store.epoch === epoch &&
          !captureSDKSessionLifetime(deps.worktree, sessionID, epoch, identity.createdAt)) {
        holdLifetimeCaptureFailure(sessionID, epoch)
      }
      return
    }
    if (!identity.parentEpoch) return
    const ownerStore = getOwnedSession(deps.worktree, identity.parentID)
    const ownerEpoch = admissionEpoch(deps.worktree, identity.parentID)
    if (!ownerStore || !ownerEpoch || ownerEpoch !== identity.parentEpoch || ownerStore.epoch !== identity.parentEpoch) return
    if (!toolTranscriptBinding(sessionID, identity.parentID, ownerEpoch)) return
    captureSDKSessionOwner(deps.worktree, sessionID, identity.parentID, identity.createdAt)
  }

  function holdLifetimeCaptureFailure(sessionID: string, epoch: string): void {
    try {
      if (getOwnedSession(deps.worktree, sessionID)?.epoch !== epoch || admissionEpoch(deps.worktree, sessionID) !== epoch) return
      holdAdmission(deps.worktree, sessionID, "sdk_session_lifetime_unavailable")
      deps.log("SDK session lifetime capacity exhausted; owner held", { sessionID, epoch })
    } catch (error) {
      deps.log("SDK session lifetime capture failed to hold owner", {
        sessionID,
        epoch,
        error: (error as Error)?.message ?? String(error),
      })
    }
  }

  return async ({ event }) => {
    try {
      await handle(event as Event)
    } catch (e) {
      deps.log("event hook error", { type: (event as Event)?.type, error: (e as Error)?.message ?? String(e) })
    }
  }

  async function handle(event: Event): Promise<void> {
    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info
        await captureAuthenticatedChildOwner(info.sessionID)
        const capture = captureSDKMessage(deps.worktree, info)
        if (!capture || !isAdmissionCurrent(deps.worktree, capture.ownerSessionID, capture.epoch)) return
        if (info.role === "assistant" && capture.ownerSessionID === info.sessionID && typeof info.time.completed === "number") {
          const persisted = await persistCompletedAssistantMessage(deps.worktree, info, () => deps.client.session.message({
            path: { id: info.sessionID, messageID: info.id },
          }))
          if (persisted.status === "failed") {
            try {
              deps.log("event hook: SDK transcript persistence failed", {
                sessionID: info.sessionID,
                messageID: info.id,
                error: (persisted.error as Error)?.message ?? String(persisted.error),
                ...(persisted.holdError === undefined ? {} : { holdError: (persisted.holdError as Error)?.message ?? String(persisted.holdError) }),
              })
            } catch {}
            let stillOwned = false
            try {
              stillOwned = getOwnedSession(deps.worktree, capture.ownerSessionID)?.epoch === capture.epoch
            } catch {}
            if (stillOwned) {
              try {
                await deps.client.session.abort({ path: { id: info.sessionID } })
              } catch (error) {
                try {
                  deps.log("event hook: SDK transcript failure abort failed", {
                    sessionID: info.sessionID,
                    error: (error as Error)?.message ?? String(error),
                  })
                } catch {}
              }
            }
            return
          }
          if (persisted.status === "stale" || persisted.status === "incomplete") return
        }
        if (!isAdmissionCurrent(deps.worktree, capture.ownerSessionID, capture.epoch)) return
        observeSkillMessage(deps, info)
        return
      }
      case "message.part.updated": {
        const part = event.properties.part
        if (part.type === "text") {
          const capture = captureSDKTextPart(deps.worktree, part)
          if (capture?.role === "assistant") return onText(part.sessionID, part.messageID, part.id, part.text, capture.ownerSessionID, capture.epoch)
          return
        }
        if (part.type === "tool") {
          let admittedCall: OpenCodeToolCall | undefined
          try {
            const proof = currentOpenCodeToolCall(deps, {
              sessionID: part.sessionID, callID: part.callID, tool: part.tool, assistantMessageID: part.messageID,
            })
            if (proof && openCodeToolCallArgumentsMatch(deps, proof, part.state.input)) admittedCall = proof
          } catch {
            // Late terminal identity facts remain retainable below; result bodies confer no authority.
          }
          // Outcomes contain only whitelisted identity/status/time/numeric-exit facts, never result bodies.
          if (toolHistoryOn && (part.state.status === "error" || part.state.status === "completed")) {
            try {
              recordToolOutcome(deps.worktree, part)
            } catch {
              try {
                deps.log("tool outcome recording failed")
              } catch {}
            }
          }
          const capture = readCapturedSDKMessage(deps.worktree, part.sessionID, part.messageID)
          if (!capture || capture.role !== "assistant") return
          const current = isAdmissionCurrent(deps.worktree, capture.ownerSessionID, capture.epoch)
          const sameOwner = getOwnedSession(deps.worktree, capture.ownerSessionID)?.epoch === capture.epoch
          let observation: ToolObservationResult | undefined
          if ((current || sameOwner) && (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error")) {
            observation = recordToolObservation(deps.worktree, {
              name: part.tool,
              callID: part.callID,
              sessionID: part.sessionID,
              status: part.state.status === "running" ? "running" : part.state.status === "completed" ? "succeeded" : "failed",
            })
          }
          const binding = toolTranscriptBinding(part.sessionID, capture.ownerSessionID, capture.epoch)
          if (binding && (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error")) {
            const observedOutcome = part.state.status === "completed" ? "succeeded" : part.state.status === "error" ? "failed" : undefined
            const outcome = part.state.status === "running" ? "running" : observation?.terminalStatus ?? observedOutcome!
            const conflictingOutcome = observation?.disposition === "conflict" && observation.terminalStatus !== "denied"
              ? observedOutcome
              : undefined
            const persisted = persistSDKToolFact(deps.worktree, {
              sessionID: part.sessionID,
              messageID: part.messageID,
              callID: part.callID,
              name: part.tool,
              outcome,
              ...(conflictingOutcome ? { observedOutcome: conflictingOutcome } : {}),
              ...binding,
            })
            if (persisted.status === "failed") {
              try {
                deps.log("event hook: SDK tool transcript persistence failed", {
                  sessionID: part.sessionID,
                  messageID: part.messageID,
                  callID: part.callID,
                  error: (persisted.error as Error)?.message ?? String(persisted.error),
                  ...(persisted.holdError === undefined ? {} : { holdError: (persisted.holdError as Error)?.message ?? String(persisted.holdError) }),
                })
              } catch {}
              let stillOwned = false
              try {
                stillOwned = getOwnedSession(deps.worktree, capture.ownerSessionID)?.epoch === capture.epoch
              } catch {}
              if (stillOwned) {
                try { await deps.client.session.abort({ path: { id: part.sessionID } }) }
                catch {}
              }
              return
            }
          } else if (capture.ownerSessionID === part.sessionID && (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error")) {
            const observedOutcome = part.state.status === "completed" ? "succeeded" : part.state.status === "error" ? "failed" : undefined
            const outcome = part.state.status === "running" ? "running" : observation?.terminalStatus ?? observedOutcome!
            const conflictingOutcome = observation?.disposition === "conflict" && observation.terminalStatus !== "denied"
              ? observedOutcome
              : undefined
            const persisted = persistSDKMainToolFact(deps.worktree, {
              sessionID: part.sessionID,
              messageID: part.messageID,
              callID: part.callID,
              name: part.tool,
              outcome,
              ...(conflictingOutcome ? { observedOutcome: conflictingOutcome } : {}),
              ownerEpoch: capture.epoch,
            })
            if (persisted.status === "failed") {
              try {
                deps.log("event hook: native-main tool transcript persistence failed", {
                  sessionID: part.sessionID,
                  messageID: part.messageID,
                  callID: part.callID,
                  error: (persisted.error as Error)?.message ?? String(persisted.error),
                  ...(persisted.holdError === undefined ? {} : { holdError: (persisted.holdError as Error)?.message ?? String(persisted.holdError) }),
                })
              } catch {}
              let stillOwned = false
              try {
                stillOwned = getOwnedSession(deps.worktree, capture.ownerSessionID)?.epoch === capture.epoch
              } catch {}
              if (stillOwned) {
                try { await deps.client.session.abort({ path: { id: part.sessionID } }) }
                catch {}
              }
              return
            }
          }
          if (!admittedCall || !current || !isAdmissionCurrent(deps.worktree, capture.ownerSessionID, capture.epoch)) return
          observeSkillPart(deps, part)
          observeRelatedToolPart(deps, part)
          if (part.state.status === "error") {
            if (!completeOpenCodeToolCall(deps, admittedCall)) return
            return onToolError(part.sessionID, part.callID, part.state.error, part.tool, capture.ownerSessionID, capture.epoch, observation)
          }
        }
        return
      }
      case "session.created": {
        const info = event.properties.info
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(info.id) ||
            (info.parentID !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(info.parentID))) return
        const settleCreation = registerPendingSDKSessionCreation(deps.worktree, info.id)
        try {
          const createdAt = info.time?.created
          const updatedAt = info.time?.updated
          if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0 ||
              typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) return
          const storeBefore = getOwnedSession(deps.worktree, info.id)
          const epochBefore = admissionEpoch(deps.worktree, info.id)
          const parentStoreBefore = info.parentID ? getOwnedSession(deps.worktree, info.parentID) : undefined
          const parentEpochBefore = info.parentID ? admissionEpoch(deps.worktree, info.parentID) : undefined
          const lookup = await deps.client.session.get({ path: { id: info.id }, query: { directory: deps.directory } })
          const vendor = lookup.data as typeof info | undefined
          const canonicalWorktree = canonicalDirectory(deps.worktree)
          const expectedDirectory = canonicalDirectory(deps.directory)
          const eventDirectory = canonicalDirectory(info.directory)
          const vendorDirectory = vendor ? canonicalDirectory(vendor.directory) : undefined
          const directoryFromWorktree = canonicalWorktree && expectedDirectory ? relative(canonicalWorktree, expectedDirectory) : undefined
          // Creation is bound by the immutable birth tuple; session.get may already observe a later touch.
          if (lookup.error || !vendor || vendor.id !== info.id || !canonicalWorktree || !expectedDirectory ||
              directoryFromWorktree === undefined || directoryFromWorktree === ".." || directoryFromWorktree.startsWith(`..${sep}`) ||
              isAbsolute(directoryFromWorktree) || eventDirectory !== expectedDirectory || vendorDirectory !== expectedDirectory ||
              vendor.parentID !== info.parentID ||
              vendor.time?.created !== createdAt || typeof vendor.time?.updated !== "number" ||
              !Number.isFinite(vendor.time.updated) || vendor.time.updated < 0 ||
              typeof vendor.time?.created !== "number" || !Number.isFinite(vendor.time.created) || vendor.time.created < 0) return
          if (getOwnedSession(deps.worktree, info.id) !== storeBefore || admissionEpoch(deps.worktree, info.id) !== epochBefore ||
              (info.parentID !== undefined && (getOwnedSession(deps.worktree, info.parentID) !== parentStoreBefore ||
                admissionEpoch(deps.worktree, info.parentID) !== parentEpochBefore))) {
            deps.log("session.created: owner changed during SDK identity validation; observation discarded", { sessionID: info.id })
            return
          }
          const identity = {
            directory: expectedDirectory,
            ...(vendor.parentID === undefined ? {} : { parentID: vendor.parentID }),
            ...(vendor.parentID !== undefined && parentStoreBefore && parentEpochBefore ? { parentEpoch: parentEpochBefore } : {}),
            createdAt: vendor.time.created,
            updatedAt: vendor.time.updated,
          }
          if (!captureSDKSessionCreationObservation(deps.worktree, info.id, identity)) {
            if (!info.parentID && storeBefore && epochBefore === storeBefore.epoch) holdLifetimeCaptureFailure(info.id, storeBefore.epoch)
            return
          }
          if (!info.parentID && storeBefore && epochBefore === storeBefore.epoch) {
            if (!captureSDKSessionLifetime(deps.worktree, info.id, storeBefore.epoch, vendor.time.created)) {
              holdLifetimeCaptureFailure(info.id, storeBefore.epoch)
              return
            }
          }
          if (info.parentID && parentStoreBefore && parentEpochBefore) await captureAuthenticatedChildOwner(info.id)
          return
        } finally {
          settleCreation()
        }
      }
      case "session.compacted": {
        const sessionID = event.properties.sessionID
        const epoch = admissionEpoch(deps.worktree, sessionID)
        if (!epoch || !isAdmissionCurrent(deps.worktree, sessionID, epoch)) return
        observeSkillBoundary(deps, sessionID, "compacted")
        const state = readModeState(deps.worktree, sessionID)
        if (!isAdmissionCurrent(deps.worktree, sessionID, epoch)) return
        writeModeState(deps.worktree, sessionID, { ...state, lastCompactedAt: Date.now() })
        deps.log("session compacted", { sessionID })
        return
      }
      case "session.idle": {
        // The workflow branch inside idle() must run even when loop.idle is disabled (settle is state repair,
        // not continuation); idle() itself decides whether it is on the workflow path.
        await idle(event.properties.sessionID)
        return
      }
      case "session.deleted": {
        const info = event.properties.info
        const id = info?.id
        if (id) {
          const attachment = getOwnedSession(deps.worktree, id)
          const capturedEpoch = capturedSDKSessionDeletionEpoch(deps.worktree, id, info.time?.created)
          const expectedEpoch = capturedEpoch
          // A session held by its own recorded stop (pending or settled pause, pending cancel) is still this lifetime.
          const stopHeld = (() => {
            try {
              const current = readWorkflow(deps.worktree, id)
              return !!current && current.sessionID === id && current.stopIntent !== null &&
                current.owner.instance === expectedEpoch && current.owner.pid === process.pid
            } catch { return false }
          })()
          if (!expectedEpoch || !attachment || attachment.epoch !== expectedEpoch || (admissionEpoch(deps.worktree, id) !== expectedEpoch && !stopHeld)) {
            deps.log("session.deleted: SDK lifetime is unbound or stale; cleanup remains read-only", {
              sessionID: id,
              capturedEpoch: expectedEpoch,
              ownedEpoch: attachment?.epoch,
            })
            return
          }
          if (deletedSessions.has(id)) {
            deps.log("session.deleted: duplicate callback retained behind deletion fence", { sessionID: id })
            return
          }
          deletedSessions.set(id, expectedEpoch)
          clearToolObservations(deps.worktree, id)
          observeSkillBoundary(deps, id, "deleted")
          guards.repetition.clear(id)
          guards.repeat.clear(id)
          try {
            holdAdmission(deps.worktree, id, "host_session_deleted")
          } catch (e) {
            deps.log("session.deleted: admission hold failed", { sessionID: id, error: (e as Error).message })
            return
          }
          const workflow = readWorkflow(deps.worktree, id)
          const workflowID = workflow?.sessionID === id ? workflow.id : null
          if (workflow?.sessionID === id) {
            const refusal = workflowEngineRefusal(workflow, runtime.host.identity.engine)
            if (refusal) {
              deps.log("session.deleted: workflow engine refused", { sessionID: id, reason: refusal })
              return
            }
            if (workflow.owner.instance !== (expectedEpoch ?? runtime.instance) || workflow.owner.pid !== process.pid) {
              deps.log("session.deleted: workflow owner is not this attachment; held for owner cleanup", { sessionID: id, epoch: expectedEpoch })
              return
            }
          }
          const running = queue.isRunning(id)
          const completion = running ? queue.completion(id) : undefined
          // Deletion is a cancel request through the normal routes. The workflow stays pending (never `cancelled`)
          // until the one settlement routine proves quiescence; the retained end follows cancel_settled.
          if (flowOn(deps.config) && workflowID && workflow && !TERMINAL.has(workflow.phase)) {
            try {
              const requested = requestStop(runtime, id, "cancel", "host_session_deleted", { workflowID })
              if (!requested.result.ok) {
                deps.log("session.deleted: workflow refused cleanup", { sessionID: id, reason: requested.result.text })
                return
              }
              await requested.quiesce
              observeStopSettlement(runtime, id, expectedEpoch, "session.deleted")
            } catch (e) {
              deps.log("session.deleted: workflow handling failed", { sessionID: id, error: (e as Error).message })
              return
            }
          }
          if (running) {
            if (!completion) {
              deps.log("session.deleted: owned runner completion unavailable", { sessionID: id })
              return
            }
            try {
              // Without a workflow stop request nothing else aborts the queue; with one this is idempotent.
              await queue.abort(id, "session deleted")
              await completion
              observeStopSettlement(runtime, id, expectedEpoch, "session.deleted")
            } catch {
              deps.log("session.deleted: queue termination is unconfirmed", { sessionID: id })
              return
            }
          }
          if (!attachment || !expectedEpoch) {
            deps.log("session.deleted: no matching local attachment; state retained and held for owner cleanup", { sessionID: id })
            return
          }
          if (getOwnedSession(deps.worktree, id)?.epoch !== expectedEpoch) {
            deps.log("session.deleted: attachment epoch changed before end", { sessionID: id, epoch: expectedEpoch })
            return
          }
          const latestWorkflow = readWorkflow(deps.worktree, id)
          if (workflowID !== (latestWorkflow?.sessionID === id ? latestWorkflow.id : null)) {
            deps.log("session.deleted: workflow changed before end", { sessionID: id, epoch: expectedEpoch })
            return
          }
          const latestPhase = latestWorkflow?.sessionID === id ? latestWorkflow.phase : undefined
          if (latestWorkflow?.sessionID === id && !TERMINAL.has(latestPhase!)) {
            // Cancellation is requested but unproven: the session stays held and retained. A later cancel_settled
            // (queue/review/stage finally, idle) re-drives the retained end exactly once.
            const unsubscribe = onCancelSettled((settledSession) => {
              if (settledSession !== id) return
              unsubscribe()
              void endAdmission(runtime, id, expectedEpoch).then(
                (ok) => deps.log(ok ? "session.deleted: session ended and retained after cancellation proof" : "session.deleted: termination remains unconfirmed after settlement", { sessionID: id, epoch: expectedEpoch }),
                () => deps.log("session.deleted: retained end failed after settlement", { sessionID: id }),
              )
            })
          }
          const ended = await endAdmission(runtime, id, expectedEpoch)
          if (!ended) deps.log("session.deleted: termination remains unconfirmed; session retained and held", { sessionID: id, epoch: expectedEpoch })
          else deps.log("session.deleted: session ended and retained", { sessionID: id, epoch: expectedEpoch })
        }
        return
      }
      default:
        return
    }
  }

  function toolTranscriptBinding(sessionID: string, ownerSessionID: string, ownerEpoch: string) {
    if (getOwnedSession(deps.worktree, ownerSessionID)?.epoch !== ownerEpoch) return undefined
    const capturedOwner = capturedSDKSessionOwner(deps.worktree, sessionID)
    if (capturedOwner && (capturedOwner.ownerSessionID !== ownerSessionID || capturedOwner.ownerEpoch !== ownerEpoch)) return undefined
    let executions: ExecutionRecord[]
    try { executions = runtime.runs.status().executions }
    catch { return undefined }
    const matches: ExecutionRecord[] = []
    for (const execution of executions) {
      if (execution.kind !== "host" || !execution.vendorRef) continue
      let reference: unknown
      try { reference = JSON.parse(execution.vendorRef) }
      catch { return undefined }
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) return undefined
      const value = reference as Record<string, unknown>
      const allowed = new Set(["executionID", "vendorSessionID", "vendorThreadID", "vendorTurnID"])
      if (Object.keys(value).some(key => !allowed.has(key))) return undefined
      if (value.vendorSessionID !== sessionID) continue
      if (execution.engine !== "opencode" || execution.ownerSession !== ownerSessionID || value.executionID !== execution.executionId || !validTranscriptID(execution.executionId) ||
          !validTranscriptID(execution.taskId) || !validTranscriptID(execution.role)) return undefined
      matches.push(execution)
    }
    if (matches.length !== 1) return undefined
    const execution = matches[0]!
    return {
      ownerSessionID,
      ownerEpoch,
      executionID: execution.executionId,
      taskID: execution.taskId,
      role: execution.role,
    }
  }

  async function onText(sessionID: string, messageID: string, partID: string, text: string, ownerSessionID: string, epoch: string) {
    if (!isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) return
    const bound = policyForOpenCodeSession(deps, sessionID)
    if (!repetitionOn && !bound) return
    const message = captureForMessage(deps.worktree, sessionID, messageID)
    if (!message || message.role !== "assistant" || message.epoch !== epoch || message.ownerSessionID !== ownerSessionID) return
    const abortKey = JSON.stringify([sessionID, ownerSessionID, epoch, partID])
    if (abortedParts.has(abortKey)) return
    const res = bound ? null : guards.repetition.feed(sessionID, partID, text)
    const cancel = bound
      ? bound.assistantText({ type: "text", sessionID, partID, text, final: false }).cancel
      : res!.repeating && deps.config.guards.abort_on_repetition
    if (res?.repeating) deps.log("repetition detected", { sessionID, partID, sample: res.sample })
    if (!cancel) return
    if (bound) deps.log("repetition detected", { sessionID, partID })
    if (!isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) return
    abortedParts.add(abortKey)
    writeJsonAtomic(abortPath(deps.worktree, sessionID), {
      reason: "repetition",
      at: Date.now(),
      messageID,
      partID,
      ...(res ? { sample: res.sample } : {}),
      chars: text.length,
    })
    try {
      await deps.client.session.abort({ path: { id: sessionID } })
      if (isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) deps.log("session aborted for repetition", { sessionID })
    } catch (e) {
      if (isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) deps.log("abort failed", { sessionID, error: (e as Error).message })
    }
  }

  function onToolError(
    sessionID: string,
    callID: string,
    error: string,
    eventName: string | undefined,
    ownerSessionID: string,
    epoch: string,
    recorded?: ToolObservationResult,
  ) {
    if (!isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) return
    const name = typeof eventName === "string" && eventName.trim()
      ? eventName
      : readToolObservations(deps.worktree, sessionID).find(observation =>
        observation.callID === callID && observation.status === "running")?.name
    let correlated = false
    if (name) {
      const observation = recorded ?? recordToolObservation(deps.worktree, { name, sessionID, callID, status: "failed" })
      if (observation.disposition === "duplicate") return
      if (observation.disposition === "conflict" && observation.terminalStatus !== "denied") return
      correlated = observation.disposition !== "ignored"
    }
    if (!correlated) {
      const key = JSON.stringify([sessionID, ownerSessionID, epoch, callID])
      if (failedCalls.has(key)) return
      failedCalls.add(key)
      while (failedCalls.size > MAX_TRACKED_CALLS) failedCalls.delete(failedCalls.values().next().value as string)
    }
    if (!isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) return
    const bound = policyForOpenCodeSession(deps, sessionID)
    if (bound && name) bound.toolResult({ type: "tool-result", sessionID, callID, toolID: callID, name, error })
    else if (repeatOn) guards.repeat.recordResult(sessionID, callID, false, error)
    if (sessionID !== ownerSessionID) return
    if (!isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) return
    const state = readModeState(deps.worktree, ownerSessionID)
    if (state.active && isAdmissionCurrent(deps.worktree, ownerSessionID, epoch)) {
      writeModeState(deps.worktree, ownerSessionID, { ...state, failures: state.failures + 1 })
    }
  }
}

function validTranscriptID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

function canonicalDirectory(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0) return undefined
  try { return realpathSync.native(path) }
  catch { return undefined }
}
