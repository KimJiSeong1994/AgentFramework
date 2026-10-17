// Role combo end to end: a ralplan pass and queue worker/reviewer children dispatch on their routed engine/model,
// while execution records and the workflow keep the anchor engine. Fixture transports only; no live model.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { createCliHost } from "../src/hosts/cli-host.ts"
import type { CliTransportHandle, CliTransportOptions } from "../src/hosts/cli-transport.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ComboRoutes, ExecutionRole } from "../src/hosts/types.ts"
import { createQueue } from "../src/orchestration/queue.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { runRalplan, startRalplan } from "../src/workflows/ralplan-driver.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

const ANCHOR = { engine: "local", model: "anchor-model" } as const
const ROUTES: ComboRoutes = {
  planner: { engine: "claude", model: "opus" },
  architect: { engine: "local", model: "arch-model" },
  critic: { engine: "claude", model: "sonnet" },
  worker: { engine: "local", model: "worker-model" },
  reviewer: { engine: "claude", model: "haiku" },
}
const SID = "ses_combo"

const final = (text: string) => JSON.stringify({ type: "final", text })
const plan = final(JSON.stringify({ type: "plan_doc", sections: [{ title: "Goal", body: "Do the thing with tests." }, { title: "Risks", body: "Few." }] }))
const architect = final(JSON.stringify({ type: "lane_verdict", status: "CLEAR", decision: "APPROVE", findings: [] }))
const critic = final(JSON.stringify({ type: "lane_verdict", verdict: "OKAY", findings: [] }))

let wt: ReturnType<typeof tempGitWorktree>
let store: SessionStore | undefined
beforeEach(() => { wt = tempGitWorktree({ "README.md": "fixture\n" }); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => {
  stopHeartbeat()
  try { store?.release({ workflowQuiescent: true, evidence: "fixture awaited all session work", workflowID: null, revision: null }) } catch { /* discarded worktree */ }
  store = undefined
  wt.cleanup()
})

function comboRuntime(responses: string[], config = structuredClone(DEFAULT_CONFIG)) {
  const dispatched: CliTransportOptions[] = []
  const createTransport = (options: CliTransportOptions): CliTransportHandle => {
    let done = false
    return {
      async run() {
        dispatched.push(options)
        const text = responses.shift()
        if (text === undefined) throw new Error("unexpected model request")
        options.onText?.(text)
        done = true
        return { status: "completed", text, quiescent: true }
      },
      async requestCancel() { done = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
      async reconcile() { return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "owned combo fixture" } },
    }
  }
  const policyRoutes = Object.fromEntries(Object.entries(ROUTES).map(([role, route]) =>
    [role, { model: { providerID: route.engine, modelID: route.model } }]))
  const runtime = createExecutionRuntime({ directory: wt.worktree, worktree: wt.worktree, config, log() {} }, ({ policy, runs }) =>
    createCliHost({ ...ANCHOR, routes: ROUTES, policy, runs, createTransport }),
    { planningOnlyMain: true, routes: policyRoutes })
  store = attachAdmission(runtime, SID, { ...ANCHOR, routes: ROUTES })
  return { runtime, dispatched }
}

const roleOf = <T extends { role: string }>(executions: readonly T[], role: string): T[] => executions.filter(execution => execution.role === role)

describe("role combo end to end", () => {
  test("a ralplan pass sends planner/architect/critic to their routes; records and workflow keep the anchor engine", async () => {
    const { runtime, dispatched } = comboRuntime([plan, architect, critic])
    const started = startRalplan(runtime, SID, "build the widget")
    if (!started.ok) throw new Error(started.text)
    expect(started.wf.engine).toBe(ANCHOR.engine)
    const result = await runRalplan(runtime, SID, started.wf.id)
    expect(result.status).toBe("pending_execution")

    expect(dispatched.map(options => [options.engine, options.model])).toEqual([
      ["claude", "opus"], ["local", "arch-model"], ["claude", "sonnet"],
    ])
    const committed = readCommitted(wt.worktree)
    if (committed.state !== "ok") throw new Error("no committed workflow")
    expect(committed.wf.engine).toBe(ANCHOR.engine)

    const executions = runtime.runs.status().executions
    for (const role of ["planner", "architect", "critic"] as const) {
      const records = roleOf(executions, role)
      expect(records).toHaveLength(1)
      expect(records[0]!.engine).toBe(ANCHOR.engine)
      expect(records[0]!.policyID).toBe(runtime.policy.resolve(role).id)
    }
    // Routed policy IDs are distinct from what an unrouted runtime would assign.
    const plain = createExecutionRuntime({ directory: wt.worktree, worktree: wt.worktree, config: structuredClone(DEFAULT_CONFIG), log() {} },
      ({ policy, runs }) => createCliHost({ ...ANCHOR, policy, runs, createTransport: () => { throw new Error("unused") } }), { planningOnlyMain: true })
    for (const role of ["planner", "architect", "critic"] as ExecutionRole[]) {
      expect(runtime.policy.resolve(role).id).not.toBe(plain.policy.resolve(role).id)
    }
  })

  test("queue worker and reviewer children dispatch on their routes with the anchor engine recorded", async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.delegate = { ...config.delegate, worktree: false, review: true, max_attempts: 1 }
    const { runtime, dispatched } = comboRuntime([
      JSON.stringify({ type: "tool", name: "write", input: { path: "out.txt", content: "done\n" } }),
      final("Files changed: out.txt\nOpen issues: none"), final("ACCEPT"),
    ], config)
    const q = createQueue(runtime)
    q.add(SID, [{ title: "no-op task" }])
    expect(await q.run(SID)).toMatchObject({ done: 1, failed: 0 })

    expect(dispatched.map(options => [options.engine, options.model])).toEqual([["local", "worker-model"], ["local", "worker-model"], ["claude", "haiku"]])
    const executions = runtime.runs.status().executions
    for (const role of ["worker", "reviewer"] as const) {
      const records = roleOf(executions, role)
      expect(records).toHaveLength(1)
      expect(records[0]!.engine).toBe(ANCHOR.engine)
      expect(records[0]!.policyID).toBe(runtime.policy.resolve(role).id)
    }
  })
})
