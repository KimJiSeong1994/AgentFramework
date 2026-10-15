import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  CONTINUE_COMMAND, CONTINUE_CONFIRMATION_PROMPT, CONTINUE_HELD_RECEIPT, CONTINUE_PAUSED_RESUMED_RECEIPT, CONTINUE_RESUMED_RECEIPT,
  CONTINUE_TEMPLATE, createCommandHook, STOP_COMMAND, STOP_TEMPLATE, consumeContinueReceipt,
} from "../src/hooks/command.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { newWorkflow, readWorkflow, workflowPath, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { applyEventIn, requestStop } from "../src/flow/runtime.ts"
import { checkResumeIn } from "../src/flow/resume.ts"
import { canonicalPlanSha, coercePlan, planMdPath, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { renderArtifact, writePlanJson } from "../src/flow/state.ts"
import { readEvents } from "../src/flow/state.ts"
import { readLedger } from "../src/state/ledger.ts"
import { admissionEpoch, attachAdmission, detachAdmission, effectiveHold, endAdmission, holdAdmission, holdOwnedAdmission } from "../src/sessions/admission.ts"
import { getOwnedSession, replaySession } from "../src/sessions/store.ts"
import { abortPath, sessionDir } from "../src/state/store.ts"
import { durableWriteJson } from "../src/state/durable.ts"
import { fakeClient, makeDeps, releaseFixtureSession, tempWorktree, verifyScript, type FakeClient } from "./guards-helpers.ts"

const S = "ses_continue"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let deps: ReturnType<typeof makeDeps>
let stores: Array<NonNullable<ReturnType<typeof getOwnedSession>>>
let vendorResponse: { data?: unknown; error?: unknown }
let statusResponse: { data?: unknown; error?: unknown }
let messagesResponse: { data?: unknown; error?: unknown }
let duringStatus: (() => void | Promise<void>) | undefined
let messageNumber = 0

beforeEach(async () => {
  wt = tempWorktree()
  client = fakeClient({ promptAsync: true })
  deps = makeDeps(client, wt.worktree)
  stores = []
  vendorResponse = { data: { id: S, directory: wt.worktree, time: { created: 1, updated: 2 } } }
  statusResponse = { data: {} }
  messagesResponse = { data: [] }
  duringStatus = undefined
  ;(client.session as any).get = async (request: unknown) => {
    client.calls.push({ method: "session.get", args: request })
    return vendorResponse
  }
  ;(client.session as any).status = async (request: unknown) => {
    client.calls.push({ method: "session.status", args: request })
    const effect = duringStatus
    duringStatus = undefined
    await effect?.()
    return statusResponse
  }
  ;(client.session as any).messages = async (request: unknown) => {
    client.calls.push({ method: "session.messages", args: request })
    return messagesResponse
  }
  stores.push(attachAdmission(getOpenCodeRuntime(deps), S, { engine: "opencode" }))
  await createEventHook(deps)({ event: { type: "session.created", properties: { info: vendorResponse.data } } } as any)
  client.calls.length = 0
})

afterEach(() => {
  for (const store of stores) releaseFixtureSession(wt.worktree, store)
  wt.cleanup()
})

async function commandHook(config: any = {}): Promise<ReturnType<typeof createCommandHook>> {
  await createConfigHook(deps)(config)
  return createCommandHook(deps)
}

async function invoke(
  hook: ReturnType<typeof createCommandHook>,
  command: string,
  args: string,
  template: string,
): Promise<string> {
  await hook({ command, sessionID: S, arguments: args }, { parts: [] })
  const id = `command_${++messageNumber}`
  const part: any = { id: `${id}_part`, sessionID: S, messageID: id, type: "text", text: template }
  await createChatMessageHook(deps)({ sessionID: S, agent: "main" } as any, {
    message: { id, sessionID: S, role: "user", agent: "main", time: { created: Date.now() } } as any,
    parts: [part],
  })
  return part.text as string
}

async function stop(hook: ReturnType<typeof createCommandHook>): Promise<void> {
  await invoke(hook, STOP_COMMAND, "", STOP_TEMPLATE)
}

function runContinue(hook: ReturnType<typeof createCommandHook>, args: string): Promise<string> {
  return invoke(hook, CONTINUE_COMMAND, args, CONTINUE_TEMPLATE)
}

function putWorkflow(patch: Partial<ReturnType<typeof newWorkflow>> = {}) {
  const store = getOwnedSession(wt.worktree, S)!
  const workflow = {
    ...newWorkflow(S, { ...currentOwner(), instance: store.epoch }, "command", "explicit Resume test", "opencode"),
    ...patch,
  }
  return withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, workflow))
}

describe("/continue explicit owner Resume", () => {
  for (const type of ["busy", "retry"]) {
    test(`native SDK ${type} state blocks Resume even with no local execution`, async () => {
      const hook = await commandHook()
      await stop(hook)
      const marker = readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))
      const abort = readFileSync(abortPath(wt.worktree, S))
      statusResponse = { data: { [S]: { type } } }
      expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))).toEqual(marker)
      expect(readFileSync(abortPath(wt.worktree, S))).toEqual(abort)
    })
  }

  for (const status of ["pending", "running"]) {
    test(`canonical SDK ${status} tool blocks Resume despite an idle status map`, async () => {
      const hook = await commandHook()
      await stop(hook)
      messagesResponse = { data: [{
        info: { id: "assistant_pending", sessionID: S },
        parts: [{ id: "pending_tool", type: "tool", sessionID: S, messageID: "assistant_pending", state: { status } }],
      }] }
      expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    })
  }

  test("a later owner stop supersedes Resume across an SDK await even at the same clock tick", async () => {
    const clock = Date.now()
    const now = spyOn(Date, "now").mockReturnValue(clock)
    try {
      const hook = await commandHook()
      await stop(hook)
      const marker = JSON.parse(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"), "utf8"))
      duringStatus = () => { holdOwnedAdmission(wt.worktree, S, "user_stop") }
      expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
      const after = JSON.parse(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"), "utf8"))
      expect(after.updatedAt).toBe(marker.updatedAt)
      expect(after.requestID).not.toBe(marker.requestID)
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
      expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    } finally { now.mockRestore() }
  })

  test("a command without an actual injection registry cannot admit a held session", async () => {
    holdAdmission(wt.worktree, S, "unregistered-command")
    const store = getOwnedSession(wt.worktree, S)!
    const before = JSON.stringify(store.metadata)
    await createCommandHook(deps)({ command: CONTINUE_COMMAND, sessionID: S, arguments: "confirm" }, { parts: [] })
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(JSON.stringify(store.metadata)).toBe(before)
    expect(client.calls.some(call => call.method === "session.get")).toBe(false)
    expect(consumeContinueReceipt(deps, S, "confirm")).toBeUndefined()
  })

  test("registers a reserved command while allowing a configured user override", async () => {
    const config: any = {}
    await commandHook(config)
    expect(config.command[CONTINUE_COMMAND]).toEqual({
      template: CONTINUE_TEMPLATE,
      description: expect.any(String),
    })

    const own: any = { command: { [CONTINUE_COMMAND]: { template: "custom owner command" } } }
    const hook = await commandHook(own)
    await hook({ command: CONTINUE_COMMAND, sessionID: S, arguments: "confirm" }, { parts: [] })
    expect(own.command[CONTINUE_COMMAND].template).toBe("custom owner command")
    expect(client.calls.filter(call => call.method === "session.get")).toHaveLength(0)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
  })

  test("ordinary, synthetic and prose continue messages cannot lift user_stop", async () => {
    const hook = await commandHook()
    await stop(hook)
    const beforeMarker = readFileSync(abortPath(wt.worktree, S))
    const beforeMetadata = readFileSync(join(sessionDir(wt.worktree, S), "metadata.json"))
    const chat = createChatMessageHook(deps)
    for (const [text, synthetic] of [
      ["hello", false],
      ["continue confirm", true],
      ["please continue", false],
    ] as const) {
      const id = `ordinary_${++messageNumber}`
      const part: any = { id: `${id}_part`, sessionID: S, messageID: id, type: "text", text, synthetic }
      await chat({ sessionID: S, agent: "main" } as any, {
        message: { id, sessionID: S, role: "user", agent: "main", time: { created: Date.now() } } as any,
        parts: [part],
      })
      expect(effectiveHold(wt.worktree, S)).toBe(true)
    }
    expect(readFileSync(abortPath(wt.worktree, S)).equals(beforeMarker)).toBe(true)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "metadata.json")).equals(beforeMetadata)).toBe(true)
    expect(client.calls.filter(call => call.method === "session.get")).toHaveLength(0)
  })

  test("continue without confirm has no admission or SDK lookup effects", async () => {
    const hook = await commandHook()
    await stop(hook)
    const store = getOwnedSession(wt.worktree, S)!
    const marker = readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))
    const abort = readFileSync(abortPath(wt.worktree, S))
    const metadata = readFileSync(join(sessionDir(wt.worktree, S), "metadata.json"))

    expect(await runContinue(hook, "")).toBe(CONTINUE_CONFIRMATION_PROMPT)
    expect(consumeContinueReceipt(deps, S, "")).toBeUndefined()
    expect(client.calls.filter(call => call.method === "session.get")).toHaveLength(0)
    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json")).equals(marker)).toBe(true)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(abort)).toBe(true)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "metadata.json")).equals(metadata)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("conflicting SDK lifetime refuses Resume before publishing admission", async () => {
    const hook = await commandHook()
    await stop(hook)
    const marker = readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))
    const abort = readFileSync(abortPath(wt.worktree, S))
    vendorResponse = { data: { id: S, directory: wt.worktree, time: { created: 2, updated: 3 } } }
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))).toEqual(marker)
    expect(readFileSync(abortPath(wt.worktree, S))).toEqual(abort)

    vendorResponse = { data: { id: S, directory: wt.worktree, time: { created: 1, updated: 2 } } }
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toEqual([])
  })

  test("confirmation acknowledges exact user_stop in the same epoch and retains transcript without dispatch", async () => {
    const hook = await commandHook()
    const store = getOwnedSession(wt.worktree, S)!
    store.append("user", { text: "retained before stop" }, "retained-user")
    store.append("assistant", { text: "retained answer" }, "retained-assistant")
    const beforeWorkflow = readWorkflow(wt.worktree)
    await stop(hook)

    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_RESUMED_RECEIPT)
    expect(consumeContinueReceipt(deps, S, "confirm")).toBeUndefined()
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    expect(admissionEpoch(wt.worktree, S)).toBe(store.epoch)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
    expect(readdirSync(sessionDir(wt.worktree, S)).some(name => name.startsWith("abort-user-stop-") && name.endsWith(".json"))).toBe(true)
    expect(replaySession(wt.worktree, S).records.map(record => record.eventID)).toContain("retained-user")
    expect(readWorkflow(wt.worktree)).toEqual(beforeWorkflow)
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync" || call.method === "create")).toHaveLength(0)
    expect(client.calls.filter(call => call.method === "session.get")).toHaveLength(2)
    expect(client.calls.filter(call => call.method === "session.get")[0]!.args).toEqual({
      path: { id: S }, query: { directory: wt.worktree },
    })
  })

  test("a restored vendor attachment stays held until the explicit command binds its new epoch", async () => {
    const hook = await commandHook()
    const runtime = getOpenCodeRuntime(deps)
    const original = getOwnedSession(wt.worktree, S)!
    original.append("user", { text: "restored history" }, "restored-user")
    expect(await detachAdmission(runtime, S, original.epoch, "test-session-switch")).toBe(true)

    const restored = attachAdmission(runtime, S, { engine: "opencode" })
    stores.push(restored)
    expect(restored.epoch).not.toBe(original.epoch)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_RESUMED_RECEIPT)
    expect(admissionEpoch(wt.worktree, S)).toBe(restored.epoch)
    expect(replaySession(wt.worktree, S).records.map(record => record.eventID)).toContain("restored-user")
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync" || call.method === "create")).toHaveLength(0)
  })

  test("restored user_stop rebinds the workflow while held, then requires explicit confirmation", async () => {
    const hook = await commandHook()
    const runtime = getOpenCodeRuntime(deps)
    const original = getOwnedSession(wt.worktree, S)!
    putWorkflow({ phase: "stuck", stuckCause: "user_stop" })
    await stop(hook)
    const stoppedWorkflow = readWorkflow(wt.worktree)!
    original.release({
      workflowQuiescent: true,
      evidence: "test fixture confirmed stopped workflow is quiescent",
      workflowID: stoppedWorkflow.id,
      revision: stoppedWorkflow.lastSeq,
    })

    const restored = attachAdmission(runtime, S, { engine: "opencode" })
    stores.push(restored)
    expect(restored.epoch).not.toBe(original.epoch)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(readWorkflow(wt.worktree)).toMatchObject({
      id: stoppedWorkflow.id,
      phase: "stuck",
      stuckCause: "user_stop",
      owner: { instance: restored.epoch },
    })
    expect(JSON.parse(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"), "utf8"))).toMatchObject({
      epoch: restored.epoch,
      held: true,
      reason: "user_stop",
    })

    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_RESUMED_RECEIPT)
    expect(admissionEpoch(wt.worktree, S)).toBe(restored.epoch)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "stuck", stuckCause: "user_stop" })
  })

  test("a held exact owner may request stop without receiving live admission", async () => {
    const hook = await commandHook()
    const runtime = getOpenCodeRuntime(deps)
    const original = getOwnedSession(wt.worktree, S)!
    expect(await detachAdmission(runtime, S, original.epoch, "test-session-switch")).toBe(true)
    const restored = attachAdmission(runtime, S, { engine: "opencode" })
    stores.push(restored)
    const binding = readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))

    await stop(hook)

    expect(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json")).equals(binding)).toBe(false)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
  })

  test("a held same-SID reader cannot stop a workflow bound to another epoch", async () => {
    const hook = await commandHook()
    holdAdmission(wt.worktree, S, "held-reader")
    putWorkflow({ owner: { ...currentOwner(), instance: "foreign-owner" } })
    const workflow = readFileSync(workflowPath(wt.worktree))
    const marker = readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))
    await stop(hook)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(workflow)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))).toEqual(marker)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
  })

  test("/continue confirm on a settled pause runs the workflow Resume: one resumed event, current epoch token, no work started", async () => {
    const hook = await commandHook()
    const workflow = putWorkflow({ phase: "planning", stage: "draft" })
    const runtime = getOpenCodeRuntime(deps)
    expect(requestStop(runtime, S, "pause", "p", { workflowID: workflow.id }).result.ok).toBe(true)
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
    expect(await runContinue(hook, "")).toBe(CONTINUE_CONFIRMATION_PROMPT)
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_PAUSED_RESUMED_RECEIPT)
    const resumed = readWorkflow(wt.worktree)!
    expect(resumed).toMatchObject({ phase: "planning", stage: "draft", stopIntent: null })
    expect(readEvents(wt.worktree, workflow.id).filter(event => event.type === "resumed")).toHaveLength(1)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)
  })

  test("/continue confirm refuses while a cancel is pending or a pause is only pending, with no admission and no mutation", async () => {
    const hook = await commandHook()
    const workflow = putWorkflow({ phase: "executing", stage: "unit" })
    const runtime = getOpenCodeRuntime(deps)
    const release = beginExecutionActivity(runtime, S, "stage")!
    expect(requestStop(runtime, S, "pause", "p", { workflowID: workflow.id }).result.ok).toBe(true)
    const pending = readFileSync(workflowPath(wt.worktree))
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(workflowPath(wt.worktree)).equals(pending)).toBe(true)
    expect(requestStop(runtime, S, "cancel", "c", { workflowID: workflow.id }).result.ok).toBe(true)
    const cancelling = readFileSync(workflowPath(wt.worktree))
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(workflowPath(wt.worktree)).equals(cancelling)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    release()
  })

  test("architect 4: /continue confirm on a pause taken in reviewing is refused by the reviewing guard (every other precondition holds)", async () => {
    const hook = await commandHook()
    // A real submitted plan: canonical json + rendered md + planRef, so subject/hash/artifact preconditions all pass.
    const plan: Plan = coercePlan({ goal: "g", revision: 1, risks: ["r"], steps: [1, 2, 3].map(n => ({ title: `step ${n}`, files: [`a${n}.txt`], detail: "d", verify: verifyScript(wt.worktree, `check${n}.sh`, "true") })) }, 1)
    const base = putWorkflow({ phase: "planning", stage: "draft" })
    const mdPath = planMdPath(base.id)
    const jsonSha = canonicalPlanSha(plan)
    const reviewing = withFlowTransaction(wt.worktree, tx => {
      writePlanJson(tx, base.id, plan)
      const mdSha = renderArtifact(tx, mdPath, renderPlanMd(base.id, plan))
      return applyEventIn(tx, getOpenCodeRuntime(deps), base, "submit_valid", "code", {}, w => ({ ...w, planRef: { jsonSha, mdPath, mdSha, revision: 1 } }), { jsonSha })
    })
    if (!reviewing.ok) throw new Error(reviewing.text)
    const runtime = getOpenCodeRuntime(deps)
    expect(reviewing.wf.phase).toBe("reviewing")
    expect(requestStop(runtime, S, "pause", "p", { workflowID: base.id }).result.ok).toBe(true)
    const paused = readFileSync(workflowPath(wt.worktree))
    // control: the same state resumes cleanly through resumePaused's own checks, so the guard is the only reason for refusal
    const check = withFlowTransaction(wt.worktree, tx => checkResumeIn(tx, runtime, S, readWorkflow(wt.worktree)!.lastSeq))
    expect(check.ok).toBe(true)
    const held: unknown[] = []
    const originalLog = deps.log
    deps.log = (message, fields) => { if (message === "/continue remains held") held.push(fields); originalLog(message, fields) }
    try { expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT) }
    finally { deps.log = originalLog }
    expect(held).toHaveLength(1)
    expect(JSON.stringify(held)).toMatch(/reviewing resumes only from the TUI or CLI/)
    expect(readFileSync(workflowPath(wt.worktree)).equals(paused)).toBe(true)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused", pausedFrom: { phase: "reviewing" } })
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)
  })

  test("architect 3: a /stop marker after a settled pause refuses the workflow Resume with zero commits", async () => {
    const hook = await commandHook()
    const workflow = putWorkflow({ phase: "planning", stage: "draft" })
    const runtime = getOpenCodeRuntime(deps)
    expect(requestStop(runtime, S, "pause", "p", { workflowID: workflow.id }).result.ok).toBe(true)
    durableWriteJson(abortPath(wt.worktree, S), { reason: "user_stop", at: Date.now(), arguments: "" })
    const paused = readFileSync(workflowPath(wt.worktree))
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(workflowPath(wt.worktree)).equals(paused)).toBe(true)
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
  })

  test("/continue confirm on a paused workflow whose rendered subject changed refuses and keeps it paused", async () => {
    const hook = await commandHook()
    const workflow = putWorkflow({
      phase: "executing", stage: "unit",
      planRef: { jsonSha: "a".repeat(64), mdPath: ".lca/plans/gone.md", mdSha: "b".repeat(64), revision: 1 },
    })
    const runtime = getOpenCodeRuntime(deps)
    expect(requestStop(runtime, S, "pause", "p", { workflowID: workflow.id }).result.ok).toBe(true)
    const paused = readFileSync(workflowPath(wt.worktree))
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(workflowPath(wt.worktree)).equals(paused)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("a stopped workflow remains stuck(user_stop) and Resume does not mutate its phase", async () => {
    const hook = await commandHook()
    const workflow = putWorkflow({ phase: "stuck", stuckCause: "user_stop" })
    await stop(hook)
    const workflowBytes = readFileSync(workflowPath(wt.worktree))

    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_RESUMED_RECEIPT)
    expect(readFileSync(workflowPath(wt.worktree)).equals(workflowBytes)).toBe(true)
    expect(readWorkflow(wt.worktree)).toEqual(workflow)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
  })

  test("missing or mismatched vendor identity leaves the held owner and stop evidence unchanged", async () => {
    const hook = await commandHook()
    await stop(hook)
    const store = getOwnedSession(wt.worktree, S)!
    const markerBefore = readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))
    const stopBefore = readFileSync(abortPath(wt.worktree, S))
    vendorResponse = { error: { name: "NotFoundError" } }
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json")).equals(markerBefore)).toBe(true)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(stopBefore)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    vendorResponse = { data: { id: "ses_foreign", directory: wt.worktree } }
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(stopBefore)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    vendorResponse = { data: { id: S, directory: "/" } }
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(stopBefore)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("engine, workflow revision and corrupt marker failures stay held without altering stop evidence", async () => {
    const hook = await commandHook()
    const workflow = putWorkflow({ phase: "stuck", stuckCause: "user_stop" })
    await stop(hook)
    const store = getOwnedSession(wt.worktree, S)!
    const markerPath = join(sessionDir(wt.worktree, S), "restore-hold.json")
    const abort = readFileSync(abortPath(wt.worktree, S))

    const metadataPath = join(sessionDir(wt.worktree, S), "metadata.json")
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, engine: "foreign-engine" }))
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    writeFileSync(metadataPath, JSON.stringify(metadata))

    const binding = JSON.parse(readFileSync(markerPath, "utf8"))
    writeFileSync(markerPath, JSON.stringify({ ...binding, workflowRevision: workflow.lastSeq + 1 }))
    const staleBinding = readFileSync(markerPath)
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(markerPath).equals(staleBinding)).toBe(true)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(abort)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    writeFileSync(markerPath, "{corrupt")
    const corruptMarker = readFileSync(markerPath)
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(markerPath).equals(corruptMarker)).toBe(true)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(abort)).toBe(true)
    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("quiescence failures and ended sessions cannot be resumed", async () => {
    const hook = await commandHook()
    const runtime = getOpenCodeRuntime(deps)
    await stop(hook)
    const releaseActivity = beginExecutionActivity(runtime, S, "review")
    expect(releaseActivity).toBeTruthy()
    const stopBytes = readFileSync(abortPath(wt.worktree, S))
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(stopBytes)).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    releaseActivity!()

    const store = getOwnedSession(wt.worktree, S)!
    durableWriteJson(join(sessionDir(wt.worktree, S), "session-end-requested.json"), {
      version: 1, sid: S, epoch: store.epoch, reason: "host_session_deleted", requestedAt: Date.now(),
    })
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
  })

  test("non-user stop reasons remain held and are never archived as user_stop", async () => {
    const hook = await commandHook()
    const store = getOwnedSession(wt.worktree, S)!
    holdAdmission(wt.worktree, S, "other-stop-reason")
    durableWriteJson(abortPath(wt.worktree, S), { reason: "repetition", at: Date.now() })
    const marker = readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json"))
    const abort = readFileSync(abortPath(wt.worktree, S))

    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "restore-hold.json")).equals(marker)).toBe(true)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(abort)).toBe(true)
    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("an idle queue is not proof of quiescence while a claim or intent remains", async () => {
    const hook = await commandHook()
    const runtime = getOpenCodeRuntime(deps)
    const queue = getQueue(runtime)
    queue.add(S, [{ title: "must remain open" }])
    const claim = runtime.runs.claim(S, runtime.instance, process.pid)
    runtime.runs.registerIntent(claim, {
      executionId: "continue-unsettled-intent",
      ownerSession: S,
      taskId: "unsettled-task",
      attemptId: "unsettled-attempt",
      generation: claim.generation,
      role: "worker",
      cwd: wt.worktree,
      policyID: "continue-test-policy",
      kind: "host",
      engine: runtime.host.identity.engine,
      profile: "legacy-unowned",
    })

    await stop(hook)

    expect(queue.isRunning(S)).toBe(false)
    expect(readLedger(wt.worktree, S).tasks.map(task => task.status)).toEqual(["pending"])
    const stopBytes = readFileSync(abortPath(wt.worktree, S))
    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    expect(readFileSync(abortPath(wt.worktree, S)).equals(stopBytes)).toBe(true)
    expect(readLedger(wt.worktree, S).tasks.map(task => task.status)).toEqual(["pending"])
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("an ended owner can be attached for history but never unheld", async () => {
    const hook = await commandHook()
    const runtime = getOpenCodeRuntime(deps)
    const store = getOwnedSession(wt.worktree, S)!
    durableWriteJson(join(sessionDir(wt.worktree, S), "session-end-requested.json"), {
      version: 1, sid: S, epoch: store.epoch, reason: "host_session_deleted", requestedAt: Date.now(),
    })
    expect(await endAdmission(runtime, S, store.epoch)).toBe(true)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-ended.json"))).toBe(true)

    expect(await runContinue(hook, "confirm")).toBe(CONTINUE_HELD_RECEIPT)
    const attached = getOwnedSession(wt.worktree, S)
    if (attached) stores.push(attached)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
  })
})
