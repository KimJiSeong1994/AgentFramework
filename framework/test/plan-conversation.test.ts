import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCodexProfile } from "../src/hosts/codex-profile.ts"
import { createPlanConversation } from "../src/hosts/plan-conversation.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionOutcome, ExecutionRequest } from "../src/hosts/types.ts"
import { tempGitWorktree, waitFor } from "./guards-helpers.ts"

const controls = Object.fromEntries([
  "boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal",
  "ownedCancellation", "quiescenceEvidence", "identityBinding", "noReplayRecovery",
  "readOnlyWorktree", "serialWorkerLease",
].map(key => [key, "supported" as const]))
let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => wt.cleanup())

function fixture(options: {
  text?: string
  prepareFailure?: boolean
  hang?: boolean
  unknown?: boolean
  incompatible?: boolean
  nativeContext?: Readonly<{ identity: string; instructions: string }>
} = {}) {
  const requests: ExecutionRequest[] = []
  let complete = false
  let resolveRun: ((outcome: ExecutionOutcome) => void) | undefined
  let cancels = 0
  const runtime = createExecutionRuntime({
    directory: wt.worktree, worktree: wt.worktree, config: structuredClone(DEFAULT_CONFIG), log() {},
  }, () => ({
    identity: { engine: "fixture", profile: "legacy-unowned" },
    async preflight() { return { compatible: !options.incompatible, controls, problems: [] } },
    async reconcile() { return { outcome: "unknown" as const, quiescent: false, evidence: "fixture has no recovery" } },
    async prepare(request) {
      requests.push(request)
      expect(runtime.runs.status().executions.at(-1)?.executionId).toBe(request.executionID)
      expect(runtime.runs.status().claim?.ownerSession).toBe(request.supervisorSessionID)
      expect(request.role).toBe("main")
      if (options.prepareFailure) throw new Error("fixture preparation failed")
      complete = false
      return {
        reference: { executionID: request.executionID },
        async run() {
          expect(runtime.runs.status().executions.at(-1)?.hostDispatch).toBe("started")
          if (options.hang) return new Promise<ExecutionOutcome>(resolve => { resolveRun = resolve })
          complete = true
          return { status: "completed" as const, text: options.text ?? "We can discuss the change first." }
        },
        async requestCancel() {
          cancels++
          complete = !options.unknown
          resolveRun?.({ status: "cancelled" })
          return { requested: true, acknowledged: true, terminal: complete, quiescent: complete }
        },
        async reconcile() {
          return { outcome: complete && !options.unknown ? "terminal" as const : "unknown" as const,
            quiescent: complete && !options.unknown, evidence: "fixture current owned handle" }
        },
      }
    },
  }), { planningOnlyMain: true, nativeContext: options.nativeContext })
  return { runtime, requests, get cancels() { return cancels }, get started() { return !!resolveRun } }
}

describe("common planning conversation", () => {
  test("CLI runtime selects the fixed planning-only main snapshot", () => {
    const runtime = createCliRuntime({ worktree: wt.worktree, engine: "local", model: "fixture-model" })
    const main = runtime.policy.resolve("main")
    expect(main.tools.allowed).toEqual(["read", "list", "glob", "grep"])
    expect(main.tools.denied).toEqual(expect.arrayContaining(["write", "bash", "delegate", "lca_flow"]))
    expect(main.system[0]).toContain("Never modify files, run commands, execute or approve plans, or delegate work")
    expect(main.nativeContext).toBeUndefined()
  })

  test("Codex CLI runtime binds the bundled native profile and refuses unknown slugs", () => {
    const profile = createCodexProfile("gpt-6-astra")
    const runtime = createCliRuntime({ worktree: wt.worktree, engine: "codex", model: "gpt-6-astra" })
    expect(runtime.policy.resolve("main").nativeContext).toEqual({
      identity: profile.catalogHash,
      instructions: profile.instructions,
    })
    expect(() => createCliRuntime({ worktree: wt.worktree, engine: "codex", model: "not-a-bundled-slug" }))
      .toThrow("unknown Codex bundled model slug")
  })

  test("planning conversation request agrees with its read-only main policy", async () => {
    const f = fixture()
    await createPlanConversation(f.runtime, "chat-policy").turn("Discuss the parser")
    const request = f.requests[0]!
    expect(request.policy).toBe(f.runtime.policy.resolve("main"))
    expect(request.policy.tools.allowed).toEqual(["read", "list", "glob", "grep"])
    expect(request.text).toContain("inspect files using the provided read-only tools")
    expect(request.text).toContain("Never modify files or run commands")
    expect(request.text).toContain("Do not claim work was executed")
    expect(request.text).not.toMatch(/do it yourself|call the delegate tool|submit plans only with lca_flow/i)
  })

  test("runtime policy binds native context outside the conversation prompt", async () => {
    const nativeContext = { identity: "codex-catalog-hash", instructions: "Native Codex instructions." }
    const f = fixture({ nativeContext })
    await createPlanConversation(f.runtime, "chat-native-context").turn("Discuss the parser")
    const request = f.requests[0]!
    expect(request.policy.nativeContext).toEqual(nativeContext)
    expect(Object.isFrozen(request.policy.nativeContext)).toBe(true)
    expect(request.policy.id).toBe(f.runtime.runs.status().executions[0]!.policyID)
    expect(request.text).not.toContain("Native Codex instructions.")
    expect(request.policy.system.join("\n")).not.toContain("Native Codex instructions.")
  })

  test("records intent before dispatch, releases quiescent lease, and carries real history", async () => {
    const f = fixture()
    const conversation = createPlanConversation(f.runtime, "chat-test")
    expect((await conversation.turn("Discuss the parser")).text).toContain("discuss")
    expect(f.runtime.runs.status().claim).toBeUndefined()
    const first = f.runtime.runs.status().executions[0]!
    expect(first.terminal?.outcome).toBe("completed")
    expect(first.reconciliation?.quiescent).toBe(true)
    await conversation.turn("Now consider empty input")
    expect(f.requests[1]!.text).toContain("Discuss the parser")
    expect(f.requests[1]!.text).toContain("Now consider empty input")
    expect(f.requests[0]!.executionID).not.toBe(f.requests[1]!.executionID)
  })

  test("extracts a model plan but does not approve or execute it", async () => {
    const plan = { goal: "Improve parser", steps: [{ title: "Change", files: ["parser.ts"], detail: "Handle empty input", verify: "bun test" }], risks: ["Regression"] }
    const f = fixture({ text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` })
    const result = await createPlanConversation(f.runtime, "chat-plan").turn("Create a plan")
    expect(result.plan).toEqual(plan)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.role).toBe("main")
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("rejects missing host controls before acquiring a lease", async () => {
    const f = fixture({ incompatible: true })
    await expect(createPlanConversation(f.runtime, "chat-refused").turn("Discuss")).rejects.toThrow("host incompatible")
    expect(f.requests).toHaveLength(0)
    expect(f.runtime.runs.status().executions).toHaveLength(0)
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("policy resolution failure does not leave an execution claim or intent", async () => {
    const f = fixture()
    f.runtime.policy.resolve = () => { throw new Error("policy resolution failed") }
    await expect(createPlanConversation(f.runtime, "chat-policy-error").turn("Discuss")).rejects.toThrow("policy resolution failed")
    expect(f.requests).toHaveLength(0)
    expect(f.runtime.runs.status().executions).toHaveLength(0)
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("preparation failure remains fenced rather than replayable", async () => {
    const f = fixture({ prepareFailure: true })
    const conversation = createPlanConversation(f.runtime, "chat-preparation")
    await expect(conversation.turn("Discuss")).rejects.toThrow("preparation failed")
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions[0]!.fence).toBeDefined()
    await expect(conversation.turn("Try again")).rejects.toThrow("existing execution claim")
    expect(f.requests).toHaveLength(1)
  })

  test("aborted input never launches and active cancellation joins owned handle", async () => {
    const f = fixture({ hang: true })
    const conversation = createPlanConversation(f.runtime, "chat-cancel")
    const early = new AbortController()
    early.abort()
    await expect(conversation.turn("Discuss", early.signal)).rejects.toThrow("cancelled")
    expect(f.requests).toHaveLength(0)
    const abort = new AbortController()
    const turn = conversation.turn("Discuss", abort.signal)
    await waitFor(() => f.started)
    await expect(conversation.turn("Concurrent")).rejects.toThrow("active turn")
    abort.abort()
    await expect(turn).rejects.toThrow("cancelled")
    expect(f.cancels).toBe(1)
    expect(f.runtime.runs.status().claim).toBeUndefined()
    expect(f.runtime.runs.status().executions[0]!.terminal?.outcome).toBe("cancelled")
  })

  test("cancellation persistence failure still stops the owned handle and fences ambiguity", async () => {
    const f = fixture({ hang: true, unknown: true })
    const persistenceError = new Error("cancel persistence failed")
    f.runtime.runs.recordCancel = () => { throw persistenceError }
    const conversation = createPlanConversation(f.runtime, "chat-cancel-persistence")
    const abort = new AbortController()
    const turn = conversation.turn("Discuss", abort.signal)
    await waitFor(() => f.started)
    abort.abort()
    await expect(turn).rejects.toThrow("cancel persistence failed")
    expect(f.cancels).toBeGreaterThan(0)
    expect(f.requests).toHaveLength(1)
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions[0]!.fence).toBeDefined()
    await expect(conversation.turn("Retry")).rejects.toThrow("existing execution claim")
    expect(f.requests).toHaveLength(1)
  })

  test("unknown quiescence keeps durable fencing even after cancellation", async () => {
    const f = fixture({ unknown: true })
    await expect(createPlanConversation(f.runtime, "chat-unknown").turn("Discuss")).rejects.toThrow("quiescence")
    expect(f.cancels).toBe(1)
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions[0]!.fence).toBeDefined()
  })

  test("bounds user context before creating any execution", async () => {
    const f = fixture()
    const conversation = createPlanConversation(f.runtime, "chat-budget")
    await expect(conversation.turn("x".repeat(24_001))).rejects.toThrow("too large")
    expect(f.requests).toHaveLength(0)
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })
})
