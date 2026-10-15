import { afterEach, beforeEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCliHost } from "../src/hosts/cli-host.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliTools, formatCliReadResult } from "../src/hosts/cli-tools.ts"
import type { CliTransportHandle, CliTransportOptions } from "../src/hosts/cli-transport.ts"
import type { ExecutionEvent, ExecutionPolicy, ExecutionRequest, ExecutionRole } from "../src/hosts/types.ts"
import { attachAdmission, detachAdmission } from "../src/sessions/admission.ts"
import { awaitSkillPermission } from "../src/skills/broker.ts"
import {
  assertSkillExecution, bindSkillInvocation, consumeSkillToolEffect, finishSkillInvocation,
  prepareSkillToolCall, readSkillToolSnapshot, revalidateSkillToolEffect, skillExecutionSignal, skillInvocationAudit,
  type SkillInvocationContext,
} from "../src/skills/context.ts"
import { resolveSkillRoots } from "../src/skills/roots.ts"
import { SkillSession } from "../src/skills/session.ts"
import { tempWorktree } from "./guards-helpers.ts"

const SID = "skill_context_session"
let fixture: ReturnType<typeof tempWorktree>
let runtime: ReturnType<typeof createCliRuntime>
let sources: SkillSession[]
let contexts: SkillInvocationContext[]
let choose: (title: string, signal: AbortSignal) => Promise<number | undefined>
let titles: string[]
let observations: number
let policy: ExecutionPolicy
const signal = () => new AbortController().signal
const terminal = () => ({ stdinIsTTY: true, stderrIsTTY: true, choose: async (title: string, _values: readonly string[], abort: AbortSignal) => {
  titles.push(title)
  return choose(title, abort)
} })

beforeEach(() => {
  fixture = tempWorktree()
  fixture.worktree = realpathSync.native(fixture.worktree)
  execFileSync("git", ["init", "--quiet"], { cwd: fixture.worktree, stdio: "pipe" })
  runtime = createCliRuntime({ worktree: fixture.worktree, engine: "local", model: "fixture/model" })
  attachAdmission(runtime, SID, { engine: "local", model: "fixture/model" })
  sources = []
  contexts = []
  titles = []
  observations = 0
  choose = async () => 0
  const base = runtime.policy
  policy = { ...base, handlers(request) {
    const handlers = base.handlers(request)
    return { ...handlers, beforeTool(event) { observations++; return handlers.beforeTool(event) } }
  } }
  writeFileSync(join(fixture.worktree, "data.txt"), "actual read result\n")
})
afterEach(() => {
  for (const context of contexts) finishSkillInvocation(context)
  for (const source of sources) source.close()
  fixture.cleanup()
})

async function binding(allowed: readonly string[], role: ExecutionRole = "main", generation = 1, deadlineMs = 60_000) {
  const directory = join(fixture.worktree, ".agents", "skills", "inspect")
  mkdirSync(directory, { recursive: true })
  const instructions = `${String.fromCodePoint(0xfeff)}---\nname: inspect\ndescription: Inspect captured inputs\nallowed-tools: [${allowed.join(", ")}]\n---\nUse exactly these captured instructions.\r\n`
  writeFileSync(join(directory, "SKILL.md"), instructions)
  writeFileSync(join(directory, "reference.txt"), "captured first line\r\ncaptured second line\r\n")
  const roots = await resolveSkillRoots({ projectRoot: fixture.worktree })
  const store = attachAdmission(runtime, SID, { engine: "local", model: "fixture/model" })
  const source = await SkillSession.create({ roots, store, terminal: terminal() }, signal())
  sources.push(source)
  const prepared = await source.prepare("inspect", signal())
  const scope = {
    executionID: randomUUID(), supervisorSessionID: SID, taskID: randomUUID(), attemptID: randomUUID(),
    generation, role, title: "Owned skill invocation", cwd: fixture.worktree, text: "Inspect data.txt", deadlineAt: Date.now() + deadlineMs,
    policy: policy.resolve(role),
  }
  const bound = bindSkillInvocation(prepared, scope, policy, terminal())
  contexts.push(bound.context)
  const request: ExecutionRequest = { ...scope, skillContext: bound.context, handlers: bound.handlers }
  const tools = createCliTools({ root: request.cwd, role, allowed: request.policy.tools.allowed, denied: request.policy.tools.denied })
  const event = (callID = "call-1", path = "data.txt"): Extract<ExecutionEvent, { type: "tool-before" }> => ({
    type: "tool-before", sessionID: request.executionID, callID, toolID: "lca:read", name: "read", input: { path },
  })
  return { source, bound, request, tools, event, instructions, directory }
}

test("source references consume admitted snapshot bytes rather than a later source reopen", async () => {
  const f = await binding(["read"])
  const event = f.event("reference", ".agents/skills/inspect/reference.txt")
  await prepareSkillToolCall(f.request, event, signal(), () => f.tools.validate(event.name, event.input))
  expect(f.request.handlers.beforeTool(event)).toEqual({ allow: true })
  expect(() => readSkillToolSnapshot(f.request, event)).toThrow("consumed exact-call proof")
  await revalidateSkillToolEffect(f.request, event, signal())
  consumeSkillToolEffect(f.request, event)
  writeFileSync(join(f.directory, "reference.txt"), "later unchecked source bytes")
  const bytes = readSkillToolSnapshot(f.request, event)
  expect(bytes).toBeDefined()
  expect(formatCliReadResult(bytes!, { path: "reference.txt", startLine: 2, maxLines: 1 })).toEqual({
    ok: true, text: "captured second line",
  })
  expect(() => readSkillToolSnapshot(f.request, event)).toThrow("consumed exact-call proof")
  expect(observations).toBe(1)
})

test("context is immutable, cannot be copied or dropped, and belongs to one request", async () => {
  const f = await binding(["read"])
  expect(f.bound.instructions).toBe(f.instructions)
  expect(Object.isFrozen(f.bound.context)).toBe(true)
  expect(Object.isFrozen(f.bound.context.allowedTools)).toBe(true)
  assertSkillExecution(f.request)
  expect(() => assertSkillExecution({ ...f.request, executionID: randomUUID() })).toThrow("another request")
  expect(() => assertSkillExecution({ ...f.request, skillContext: { ...f.bound.context } })).toThrow("copied")
  expect(() => assertSkillExecution({ ...f.request, skillContext: undefined })).toThrow("authentic invocation context")
  expect(() => assertSkillExecution({ ...f.request, skillContext: skillInvocationAudit(f.bound.context) as unknown as SkillInvocationContext })).toThrow("copied")
  expect(observations).toBe(0)
})

test("in-scope call needs fresh capture and consumes only once without re-observing policy", async () => {
  const f = await binding(["read"])
  const event = f.event()
  await prepareSkillToolCall(f.request, event, signal(), () => f.tools.validate(event.name, event.input))
  expect(f.request.handlers.beforeTool(event)).toEqual({ allow: true })
  expect(() => consumeSkillToolEffect(f.request, event)).toThrow("absent or stale")
  await revalidateSkillToolEffect(f.request, event, signal())
  consumeSkillToolEffect(f.request, event)
  expect(() => consumeSkillToolEffect(f.request, event)).toThrow("exact-call proof")
  f.request.handlers.toolResult({ ...event, type: "tool-result", result: "actual read result" })
  await expect(prepareSkillToolCall(f.request, event, signal(), () => true)).rejects.toThrow("identity")
  expect(observations).toBe(1)
  expect(titles).toHaveLength(1)
})

test("allow-once retries the same call without charging base policy twice or mutating its ID", async () => {
  const f = await binding(["grep"])
  const event = f.event()
  const id = f.request.policy.id
  await prepareSkillToolCall(f.request, event, signal(), () => f.tools.validate(event.name, event.input))
  const decision = f.request.handlers.beforeTool(event)
  expect(decision.allow).toBe(false)
  if (decision.allow || !decision.holdTicket) throw new Error("expected authentic foreground ticket")
  const permit = await awaitSkillPermission(decision.holdTicket, { signal: skillExecutionSignal(f.request, signal()) })
  expect(permit).toBeDefined()
  await revalidateSkillToolEffect(f.request, event, signal())
  consumeSkillToolEffect(f.request, event, permit)
  expect(() => consumeSkillToolEffect(f.request, event, permit)).toThrow()
  expect(f.request.policy.id).toBe(id)
  expect(f.request.policy.tools.allowed).toContain("read")
  expect(observations).toBe(1)
  expect(titles).toHaveLength(2)
})

test("path and worker-scope denials never create a permission prompt", async () => {
  const f = await binding(["grep"], "worker")
  const outside = f.event("outside", "../outside.txt")
  await expect(prepareSkillToolCall(f.request, outside, signal(), () => f.tools.validate(outside.name, outside.input))).rejects.toThrow("path")
  const valid = f.event("worker-read")
  await prepareSkillToolCall(f.request, valid, signal(), () => f.tools.validate(valid.name, valid.input))
  const decision = f.request.handlers.beforeTool(valid)
  expect(decision.allow).toBe(false)
  expect("holdTicket" in decision).toBe(false)
  expect(titles).toHaveLength(1)
})

test("changed source after a choice cannot mint an allow-once permit", async () => {
  const f = await binding(["grep"])
  const event = f.event()
  await prepareSkillToolCall(f.request, event, signal(), () => f.tools.validate(event.name, event.input))
  const decision = f.request.handlers.beforeTool(event)
  if (decision.allow || !decision.holdTicket) throw new Error("expected foreground ticket")
  choose = async () => { writeFileSync(join(f.directory, "added.txt"), "changed complete-tree manifest"); return 0 }
  expect(await awaitSkillPermission(decision.holdTicket, { signal: skillExecutionSignal(f.request, signal()) })).toBeUndefined()
  expect(observations).toBe(1)
})

test("binding refuses a request from another supervisor session before any observation or choice", async () => {
  const f = await binding(["read"])
  const other = f.source
  const prompted = titles.length
  const prepared = await other.prepare("inspect", signal())
  const scope = { ...f.request, supervisorSessionID: "another_supervisor_session" } as Record<string, unknown>
  delete scope.skillContext
  delete scope.handlers
  expect(() => bindSkillInvocation(prepared, scope as never, policy, terminal())).toThrow("cannot cross supervisor sessions")
  expect(observations).toBe(0)
  expect(titles).toHaveLength(prompted)
})

test("a real detach and reattach changes the epoch and refuses the bound context before any effect", async () => {
  const f = await binding(["read"])
  const event = f.event()
  const before = f.bound.context.attachmentEpoch
  const prompted = titles.length
  expect(before).toBe(f.source.store.epoch)
  expect(await detachAdmission(runtime, SID, before, "epoch-change")).toBe(true)
  const reattached = attachAdmission(runtime, SID, { engine: "local", model: "fixture/model" })
  expect(reattached.epoch).not.toBe(before)
  expect(f.bound.context.attachmentEpoch).toBe(before)
  expect(() => assertSkillExecution(f.request)).toThrow("missing, copied, expired")
  let validated = 0
  await expect(prepareSkillToolCall(f.request, event, signal(), () => { validated++; return true })).rejects.toThrow()
  expect(validated).toBe(0)
  expect(f.request.handlers.beforeTool(event)).toMatchObject({ allow: false })
  expect(() => consumeSkillToolEffect(f.request, event)).toThrow()
  expect(() => readSkillToolSnapshot(f.request, event)).toThrow()
  expect(observations).toBe(0)
  expect(titles).toHaveLength(prompted)
})

function transport(responses: string[], prompts: string[]): (options: CliTransportOptions) => CliTransportHandle {
  return options => {
    let finished = false
    return {
      async run() {
        prompts.push(options.prompt)
        const text = responses.shift()
        if (text === undefined) throw new Error("unexpected model dispatch")
        options.onText?.(text)
        finished = true
        return { status: "completed", text, quiescent: true }
      },
      async requestCancel() { finished = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "controlled fixture has no process" } },
      async reconcile() { return { outcome: finished ? "terminal" : "running", quiescent: finished, evidence: "controlled fixture transport state" } },
    }
  }
}

async function ownedHost(allowed: readonly string[], deadlineMs = 60_000) {
  const claim = runtime.runs.claim(SID, runtime.instance, process.pid)
  const f = await binding(allowed, "main", claim.generation, deadlineMs)
  const responses = [JSON.stringify({ type: "tool", name: "read", input: { path: "data.txt" } }), JSON.stringify({ type: "final", text: "Read completed." })]
  const prompts: string[] = []
  const host = createCliHost({ engine: "local", model: "fixture/model", policy, runs: runtime.runs, createTransport: transport(responses, prompts) })
  runtime.runs.registerIntent(claim, {
    executionId: f.request.executionID, ownerSession: SID, taskId: f.request.taskID, attemptId: f.request.attemptID,
    generation: claim.generation, role: "main", cwd: f.request.cwd, policyID: f.request.policy.id,
    kind: "host", engine: "local", profile: "legacy-unowned", controlProfile: host.identity.controlProfile,
  })
  const handle = await host.prepare(f.request)
  runtime.runs.markHostDispatched(claim, f.request.executionID)
  const settle = async () => {
    runtime.runs.reconcile(claim, f.request.executionID, await handle.reconcile())
    runtime.runs.release(claim)
  }
  return { ...f, handle, prompts, settle }
}

test("real CLI host waits then retries the same read call through the broker", async () => {
  const f = await ownedHost(["grep"])
  const outcome = await f.handle.run()
  expect(outcome.status).toBe("completed")
  expect(f.prompts).toHaveLength(2)
  expect(f.prompts[1]).toContain("actual read result")
  expect(observations).toBe(1)
  expect(titles).toHaveLength(2)
  await f.settle()
})

test("CLI cancellation without a native transport aborts the pending permission wait", async () => {
  const f = await ownedHost(["grep"])
  let entered!: () => void
  let answer!: (value: number) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  choose = async () => { entered(); return new Promise<number>(resolve => { answer = resolve }) }
  const pending = f.handle.run()
  await started
  const cancellation = await f.handle.requestCancel("operator cancelled permission", Date.now() + 2_000)
  expect(cancellation.requested).toBe(true)
  expect((await pending).status).toBe("cancelled")
  answer(0)
  await Promise.resolve()
  expect(f.prompts).toHaveLength(1)
  expect(observations).toBe(1)
  await f.settle()
})

test("real CLI host: deadline expiring during a pending allow-once ends failed with one prompt and no effect", async () => {
  const f = await ownedHost(["grep"], 3_500)
  const consentPrompts = titles.length
  let entered!: () => void
  let chooserSignal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  choose = async (_title, abort) => { chooserSignal = abort; entered(); return new Promise<number>(() => {}) }
  const pending = f.handle.run()
  await started
  const outcome = await pending
  expect(outcome.status).toBe("failed")
  expect(titles).toHaveLength(consentPrompts + 1)
  expect(chooserSignal?.aborted).toBe(true)
  expect(Date.now()).toBeGreaterThanOrEqual(f.request.deadlineAt - 2_000)
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts.some(prompt => prompt.includes("actual read result"))).toBe(false)
  expect(observations).toBe(1)
  await f.settle()
})

test("real CLI host: a request whose remaining time cannot fit a permission wait is denied without a chooser", async () => {
  const f = await ownedHost(["grep"], 1_900)
  const consentPrompts = titles.length
  expect(f.request.deadlineAt - Date.now()).toBeLessThanOrEqual(1_900)
  const outcome = await f.handle.run()
  expect(outcome.status).toBe("failed")
  expect(titles).toHaveLength(consentPrompts)
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts.some(prompt => prompt.includes("actual read result"))).toBe(false)
  expect(observations).toBe(1)
  await f.settle()
})
