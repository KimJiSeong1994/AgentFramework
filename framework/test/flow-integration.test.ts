// M1 end-to-end: /plan -> lca_flow (review) -> /approve -> delegate return -> settle, plus /reject, /cancel,
// stuck(plan_invalid) -> /reject, two-"instance" (owner field) authority scenarios, and plugin-load repair. Every
// hook is driven the way OpenCode's plugin runtime drives it: command.execute.before (createCommandHook) marks the
// turn, then chat.message does the §5.2/§5.3/§5.5 state work and rewrites the command's own text in place, the
// lca_flow tool runs the review inline, and tool.execute.after settles on delegate return.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  APPROVE_COMMAND, APPROVE_TEMPLATE, CANCEL_COMMAND, CANCEL_TEMPLATE, PLAN_COMMAND, PLAN_TEMPLATE,
  REJECT_COMMAND, REJECT_TEMPLATE_PREFIX, REJECT_TEMPLATE_SUFFIX, createCommandHook,
} from "../src/hooks/command.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { LcaPlugin } from "../src/index.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createLcaFlowTool } from "../src/tools/lca-flow.ts"
import { createIdleLoop } from "../src/loop/idle.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { repairOnLoad } from "../src/flow/runtime.ts"
import { createDelegateTool } from "../src/tools/delegate.ts"
import { readEvents, readWorkflow, writeWorkflow, newWorkflow, planJsonPath, renderArtifact, type Workflow } from "../src/flow/state.ts"
import { currentOwner, INSTANCE_ID } from "../src/flow/owner.ts"
import { canonicalPlanSha, planMdPath, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { readLedger, tasksForWorkflow, writeLedger, addTasks } from "../src/state/ledger.ts"
import { sessionDir, writeJsonAtomic } from "../src/state/store.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { createTaskWorktree, taskWorktreeOwner } from "../src/orchestration/worktree.ts"
import { fakeClient, makeDeps, tempGitWorktree, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let messageSequence = 0

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
})
afterEach(() => wt.cleanup())

function validPlanArgs() {
  return {
    goal: "fix the bug",
    steps: [
      { title: "one", files: ["src/a.ts"], detail: "d", verify: "sh verify-a.test.sh" },
      { title: "two", files: ["src/b.ts"], detail: "d", verify: "sh verify-b.test.sh" },
      { title: "three", files: ["src/c.ts"], detail: "d", verify: "sh verify-c.test.sh" },
    ],
    risks: ["might miss an edge case"],
  }
}

function toolCtx(sessionID = S, agent = "main") {
  const ac = new AbortController()
  return { sessionID, messageID: "m1", agent, directory: wt.worktree, worktree: wt.worktree, abort: ac.signal, controller: ac, metadata: () => {}, ask: async () => {} }
}

/** Drive one flow command exactly as OpenCode would: command.execute.before marks the turn, chat.message rewrites the template. */
async function runCommand(deps: ReturnType<typeof makeDeps>, command: string, args: string, template: string, sessionID = S): Promise<string> {
  const commandHook = createCommandHook(deps, { stop: true, status: true, flow: true })
  await commandHook({ command, sessionID, arguments: args }, { parts: [] })
  const messageID = `message_${++messageSequence}_${command}_${sessionID}`
  const part: any = { id: `part_${messageID}`, sessionID, messageID, type: "text", text: template }
  await createChatMessageHook(deps)({ sessionID, agent: "main" } as any, {
    message: { id: messageID, sessionID, role: "user", time: { created: Date.now() } } as any,
    parts: [part],
  })
  return part.text as string
}

async function runUserTurn(
  deps: ReturnType<typeof makeDeps>,
  text: string,
  options: { agent?: string; synthetic?: boolean; role?: "user" | "assistant"; id?: string; sessionID?: string } = {},
): Promise<any> {
  const id = options.id ?? `interactive_${++messageSequence}`
  const sessionID = options.sessionID ?? S
  const part: any = { id: `${id}_part`, sessionID, messageID: id, type: "text", text, synthetic: options.synthetic }
  await createChatMessageHook(deps)({ sessionID, agent: options.agent ?? "main" } as any, {
    message: { id, sessionID, role: options.role ?? "user", time: { created: Date.now() } } as any,
    parts: [part],
  })
  return part
}

function eventTypes(worktree: string, wfId: string): string[] {
  return readEvents(worktree, wfId).map((e) => e.type)
}

describe("1) /plan -> review (ITERATE then OKAY) -> /approve -> tasks done -> delegate return settles -> done", () => {
  test("full happy path", async () => {
    wt.cleanup()
    wt = tempGitWorktree({
      "verify-a.test.sh": "test -s src/a.ts",
      "verify-b.test.sh": "test -s src/b.ts",
      "verify-c.test.sh": "test -s src/c.ts",
    })
    mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
    const deps = makeDeps(client, wt.worktree)

    const planText = await runCommand(deps, PLAN_COMMAND, "add a widget", PLAN_TEMPLATE)
    expect(planText).toBe(`Request: add a widget\n\n${PLAN_TEMPLATE}`)
    let wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.entry).toBe("command")

    const tool = createLcaFlowTool(deps)

    // first submission: reviewer asks for changes (T4 -> reviewing -> T5 -> planning)
    client.replies.reviewer = { text: "- step 2 needs a narrower verify command\nVERDICT: ITERATE" }
    const iterateRes = (await tool.execute({ op: "plan", plan: validPlanArgs() }, toolCtx() as any)) as { output: string }
    expect(iterateRes.output).toContain("Reviewer asked for changes")
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.review_iterations).toBe(1)

    // resubmit: reviewer okays it (T4 -> reviewing -> T7 -> pending_approval)
    client.replies.reviewer = { text: "- looks solid\nVERDICT: OKAY" }
    const okayRes = (await tool.execute({ op: "plan", plan: validPlanArgs() }, toolCtx() as any)) as { output: string }
    expect(okayRes.output).toContain("Plan saved to")
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("pending_approval")
    expect(wf.review?.verdict).toBe("okay")

    const approveText = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE)
    expect(approveText).toBe(APPROVE_TEMPLATE)
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("executing")
    const tagged = tasksForWorkflow(readLedger(wt.worktree, S), wf.id)
    expect(tagged.length).toBe(3)
    expect(tagged.map((t) => t.title)).toEqual(validPlanArgs().steps.map((s) => s.title))

    client.replies.worker = (_request, nth) => ({
      text: "Implemented the requested change.",
      run: async () => {
        const file = ["src/a.ts", "src/b.ts", "src/c.ts"][nth - 1]!
        mkdirSync(join(wt.worktree, file.slice(0, file.lastIndexOf("/"))), { recursive: true })
        writeFileSync(join(wt.worktree, file), `export const ${String.fromCharCode(96 + nth)} = ${nth};\n`)
      },
    })
    client.replies.reviewer = { text: "The diff and verification are acceptable.\nACCEPT" }
    const delegated = await createDelegateTool(deps).execute({ resume: true }, toolCtx() as any) as { title: string }
    expect(delegated.title).toBe("delegate: 3/3 done")

    // Settle through the real delegate return hook, not a synthetic ledger mutation.
    const afterHook = createToolAfterHook(deps)
    await afterHook({ tool: "delegate", sessionID: S, callID: "c1", args: {} } as any, { title: "delegate", output: "ok", metadata: {} } as any)

    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("done")

    const types = eventTypes(wt.worktree, wf.id)
    expect(types).toEqual([
      "created", "transition", // T1 -> planning
      "transition", "plan_submitted", // T4 -> reviewing (1st submission)
      "transition", // T5 -> planning (iterate)
      "transition", "plan_submitted", // T4 -> reviewing (2nd submission)
      "transition", // T7 -> pending_approval
      "transition", "approved", // T9 -> executing
      "tasks_created",
      "transition", // settle_ok -> done
    ])
  }, 10_000) // Includes real Git snapshots and three shell verifications; not a latency benchmark.
})

describe("2) /reject from pending_approval -> planning, counters.user_rejections", () => {
  test("reject with a reason", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)

    const deps = makeDeps(client, wt.worktree)
    const text = await runCommand(deps, REJECT_COMMAND, "needs more detail", `${REJECT_TEMPLATE_PREFIX}<reason>${REJECT_TEMPLATE_SUFFIX}`)
    expect(text).toBe(`${REJECT_TEMPLATE_PREFIX}needs more detail${REJECT_TEMPLATE_SUFFIX}`)

    const after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("planning")
    expect(after.counters.user_rejections).toBe(1)
    expect(eventTypes(wt.worktree, wf.id)).toContain("rejected")
  })
})

describe("3) /cancel in executing while the queue runs -> pendingCancel, settles to cancelled once the queue stops", () => {
  test("cancel then settle", async () => {
    wt.cleanup()
    wt = tempGitWorktree()
    mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
    const wf = { ...newWorkflow(S, currentOwner(), "command", "do the thing"), phase: "executing" as const, taskIds: ["t1"] }
    writeWorkflow(wt.worktree, wf)
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "tagged task" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, ledger)

    const deps = makeDeps(client, wt.worktree)
    const q = getQueue(getOpenCodeRuntime(deps))
    // keep the queue "running" with an unrelated blocker task until abort() unblocks it
    client.replies.worker = { text: "never", run: () => new Promise<void>(() => {}) }
    q.add(S, [{ title: "blocker" }])
    const running = q.run(S)
    while (!q.isRunning(S)) await new Promise((r) => setTimeout(r, 2))

    const cancelText = await runCommand(deps, CANCEL_COMMAND, "", CANCEL_TEMPLATE)
    expect(cancelText).toBe(CANCEL_TEMPLATE)
    let after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing") // T18 queueRunning=true -> pendingCancel, phase unchanged
    expect(after.pendingCancel).toBe(true)

    await running // the abort triggered by cancelWorkflow unblocks the queue run
    expect(q.isRunning(S)).toBe(false)

    await createIdleLoop(deps)(S) // settle: pendingCancel + queue stopped -> cancel_settled
    after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("cancelled")
    expect(after.pendingCancel).toBeUndefined()

    const taggedAfter = tasksForWorkflow(readLedger(wt.worktree, S), wf.id)
    expect(taggedAfter.every((t) => t.status === "cancelled")).toBe(true)
    expect(eventTypes(wt.worktree, wf.id)).toContain("transition")
  })
})

describe("4) three invalid plans -> stuck(plan_invalid) -> /reject -> planning", () => {
  test("stuck then reject", async () => {
    const deps = makeDeps(client, wt.worktree)
    await runCommand(deps, PLAN_COMMAND, "add a widget", PLAN_TEMPLATE)
    const tool = createLcaFlowTool(deps)
    const badPlan = { ...validPlanArgs(), steps: [{ title: "s1", files: ["x"], verify: "true" }] } // too few steps + trivial verify
    for (let i = 0; i < 3; i++) await tool.execute({ op: "plan", plan: badPlan }, toolCtx() as any)
    let wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("stuck")
    expect(wf.stuckCause).toBe("plan_invalid")
    expect(wf.counters.code_invalid).toBe(3)

    const text = await runCommand(deps, REJECT_COMMAND, "try again", `${REJECT_TEMPLATE_PREFIX}<reason>${REJECT_TEMPLATE_SUFFIX}`)
    expect(text).toBe(`${REJECT_TEMPLATE_PREFIX}try again${REJECT_TEMPLATE_SUFFIX}`)
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.user_rejections).toBe(1)
    expect(wf.counters.code_invalid).toBe(0)
    expect(eventTypes(wt.worktree, wf.id)).toContain("rejected")
  })
})

describe("5) two plugin instances on one state root: a foreign LIVE session refuses /approve, no mutation", () => {
  test("live foreign owner refuses approve", async () => {
    mkdirSync(sessionDir(wt.worktree, OTHER), { recursive: true })
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    // a second "plugin instance" (different instance id, same live process, fresh heartbeat) owns the workflow
    const wf: Workflow = {
      ...newWorkflow(OTHER, currentOwner(Date.now(), "inst_other_B", process.pid), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)

    const before = JSON.stringify(readWorkflow(wt.worktree))
    const deps = makeDeps(client, wt.worktree)
    const text = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE, S)
    expect(text).toContain(`owned by session ${OTHER}`)
    expect(JSON.stringify(readWorkflow(wt.worktree))).toBe(before)
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
    expect(readLedger(wt.worktree, OTHER).tasks.length).toBe(0)
  })
})

describe("6) interrupted approve (tagged tasks exist, phase still pending_approval) repaired by repairOnLoad", () => {
  test("repair finishes the approve: executing + tasks_created(repair)", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval", // the crash happened after the ledger write but before the phase write
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)
    const { ledger } = addTasks(readLedger(wt.worktree, S), validPlanArgs().steps.map((s) => ({ title: s.title })), Date.now(), { id: "wfid", planSha: jsonSha })
    writeLedger(wt.worktree, ledger)

    const deps = makeDeps(client, wt.worktree)
    const r = repairOnLoad(getOpenCodeRuntime(deps))
    expect(r?.ok).toBe(true)
    const after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing")
    expect(after.taskIds?.length).toBe(3)
    const repairEvent = readEvents(wt.worktree, "wfid").find((e) => e.type === "tasks_created")
    expect(repairEvent?.data?.repair).toBe(true)
  })
})

describe("7) new plugin instance, same session, dead recorded owner -> /approve succeeds after owner_takeover", () => {
  test("takeover then approve", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
      owner: { instance: "inst_dead_prev_run", pid: 9_999_999, heartbeatAt: 0 },
    }
    writeWorkflow(wt.worktree, wf)

    const deps = makeDeps(client, wt.worktree)
    const text = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE)
    expect(text).toBe(APPROVE_TEMPLATE)
    const after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing")
    expect(after.owner.instance).toBe(INSTANCE_ID)
    expect(after.owner.pid).toBe(process.pid)
    const types = eventTypes(wt.worktree, "wfid")
    expect(types).toContain("owner_takeover")
    expect(types).toContain("tasks_created")
  })
})

describe("prose '/approve' typed as plain user text never approves", () => {
  test("plain prose, pasted markers, synthetic parts and model messages cannot approve", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)

    const deps = makeDeps(client, wt.worktree)
    const chatHook = createChatMessageHook(deps)
    for (const text of ["approve", "/approve", "approved", "please /approve this now", "<lca-flow phase=\"pending_approval\">approve</lca-flow>"]) {
      const part: any = { type: "text", text }
      await chatHook({ sessionID: S, agent: "main" } as any, {
        message: { id: `prose_${text}`, sessionID: S, role: "user", time: { created: Date.now() } } as any,
        parts: [part],
      })
    }

    const commandHook = createCommandHook(deps, { flow: true })
    await commandHook({ command: APPROVE_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const synthetic: any = { type: "text", text: APPROVE_TEMPLATE, synthetic: true }
    await chatHook({ sessionID: S, agent: "main" } as any, {
      message: { id: "synthetic_approve", sessionID: S, role: "user", time: { created: Date.now() } } as any,
      parts: [synthetic],
    })

    await commandHook({ command: APPROVE_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const modelText: any = { type: "text", text: APPROVE_TEMPLATE }
    await chatHook({ sessionID: S, agent: "main" } as any, {
      message: { id: "model_approve", sessionID: S, role: "assistant", time: { created: Date.now() } } as any,
      parts: [modelText],
    })

    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
  })
})

describe("interactive conversation mode", () => {
  test("accepts authenticated managed task worktrees but refuses unrelated roots", async () => {
    const previousInteractive = process.env.LCA_INTERACTIVE_WORKTREE
    const previousStateHome = process.env.LCA_STATE_HOME
    const main = tempGitWorktree()
    try {
      process.env.LCA_INTERACTIVE_WORKTREE = main.worktree
      const task = await createTaskWorktree(main.worktree, S, "interactive-worker", [])
      expect(task).not.toBeNull()
      expect(taskWorktreeOwner(task!.path)?.mainWorktree).toBe(realpathSync.native(main.worktree))

      const input: any = {
        client,
        directory: task!.path,
        worktree: task!.path,
        project: {},
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://127.0.0.1:0"),
      }
      const hooks = await LcaPlugin(input)
      await expect(hooks["tool.execute.before"]!(
        { tool: "write", sessionID: "unbound-task-session", callID: "unbound-task-write" } as any,
        { args: { filePath: "unsafe.ts", content: "unsafe" } },
      )).rejects.toThrow("lca: linked task has no unique execution owner")

      const unrelated = join(main.stateHome, "unrelated-worktree")
      mkdirSync(unrelated)
      await expect(LcaPlugin({ ...input, directory: unrelated, worktree: unrelated })).rejects.toThrow(/does not match this plugin worktree/)
    } finally {
      if (previousInteractive === undefined) delete process.env.LCA_INTERACTIVE_WORKTREE
      else process.env.LCA_INTERACTIVE_WORKTREE = previousInteractive
      await main.cleanup()
      if (previousStateHome === undefined) delete process.env.LCA_STATE_HOME
      else process.env.LCA_STATE_HOME = previousStateHome
    }
  })

  test("interactive command mark without user role cannot approve", async () => {
    const jsonPath = planJsonPath(wt.worktree, "interactive_pending")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("interactive_pending")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("interactive_pending", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    writeWorkflow(wt.worktree, {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "interactive_pending",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    })

    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    await createCommandHook(deps, { flow: true })({ command: APPROVE_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const part: any = { type: "text", text: APPROVE_TEMPLATE }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" } as any, { message: {} as any, parts: [part] })

    expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks).toHaveLength(0)
  })

  test("validates the canonical worktree, required hooks and approval command without replacing user config", async () => {
    const previousInteractive = process.env.LCA_INTERACTIVE_WORKTREE
    const previousXdg = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = join(wt.stateHome, "xdg")
      const input: any = {
        client,
        directory: wt.worktree,
        worktree: wt.worktree,
        project: {},
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://127.0.0.1:0"),
      }

      process.env.LCA_INTERACTIVE_WORKTREE = wt.stateHome
      await expect(LcaPlugin(input)).rejects.toThrow(/does not match this plugin worktree/)

      process.env.LCA_INTERACTIVE_WORKTREE = wt.worktree
      const projectConfig = join(wt.worktree, ".lca", "lca.jsonc")
      mkdirSync(join(wt.worktree, ".lca"), { recursive: true })
      writeFileSync(projectConfig, JSON.stringify({ disabled_hooks: ["guard.plan_boundary"] }))
      await expect(LcaPlugin(input)).rejects.toThrow(/guard.plan_boundary/)

      writeFileSync(projectConfig, "{}")
      const hooks = await LcaPlugin(input)
      const hostConfig: any = { command: { approve: { template: "user-defined approval" } } }
      await expect(hooks.config!(hostConfig)).rejects.toThrow(/conflicts with the typed approval command/)
      expect(hostConfig.command.approve.template).toBe("user-defined approval")
    } finally {
      if (previousInteractive === undefined) delete process.env.LCA_INTERACTIVE_WORKTREE
      else process.env.LCA_INTERACTIVE_WORKTREE = previousInteractive
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
    }
  })

  test("ordinary main-agent language starts planning before tools and preserves the active workflow", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const firstRequest = "Add an export option and cover it with a test."
    await runUserTurn(deps, firstRequest, { id: "interactive_first" })
    const first = readWorkflow(wt.worktree)!
    expect(first).toMatchObject({ phase: "planning", entry: "keyword", request: firstRequest })
    expect(readEvents(wt.worktree, first.id).find((event) => event.type === "created")?.actor).toBe("user_keyword")

    const toolBefore = createToolBeforeHook(deps)
    await expect(toolBefore(
      { tool: "write", sessionID: S, callID: "before-planning-write" } as any,
      { args: { filePath: "new.ts", content: "unsafe" } },
    )).rejects.toThrow(/planning phase — read-only/)

    await runUserTurn(deps, "Also update the related docs.", { id: "interactive_second" })
    const second = readWorkflow(wt.worktree)!
    expect(second.id).toBe(first.id)
    expect(second.request).toBe(firstRequest)
  })

  test("natural turn takes over a restarted workflow before protecting it from another session", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const previous = writeWorkflow(wt.worktree, {
      ...newWorkflow(S, currentOwner(), "keyword", "resume planning"),
      owner: { instance: "inst_previous_plugin", pid: process.pid, heartbeatAt: 0 },
    })

    await runUserTurn(deps, "Continue with the requested investigation.", { id: "interactive_restart_owner" })
    const takenOver = readWorkflow(wt.worktree)!
    expect(takenOver.id).toBe(previous.id)
    expect(takenOver.owner.instance).toBe(INSTANCE_ID)
    expect(eventTypes(wt.worktree, previous.id)).toContain("owner_takeover")

    mkdirSync(sessionDir(wt.worktree, OTHER), { recursive: true })
    const foreignTurn = await runUserTurn(deps, "Start an unrelated request.", { id: "interactive_foreign_after_takeover", sessionID: OTHER })
    expect(foreignTurn.text).toContain(`already active in session ${S}`)
    const afterForeignTurn = readWorkflow(wt.worktree)!
    expect(afterForeignTurn.id).toBe(previous.id)
    expect(afterForeignTurn.owner.instance).toBe(INSTANCE_ID)
    expect(eventTypes(wt.worktree, previous.id)).not.toContain("owner_dead")
  })

  test("child and synthetic turns do not start workflows", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    await runUserTurn(deps, "Do child work", { agent: "worker", id: "interactive_child" })
    await runUserTurn(deps, "Synthetic follow-up", { synthetic: true, id: "interactive_synthetic" })
    await runUserTurn(deps, "Assistant-originated text", { role: "assistant", id: "interactive_model" })
    await runUserTurn(deps, "   ", { id: "interactive_empty" })
    expect(readWorkflow(wt.worktree)).toBeNull()
  })

  test("missing, foreign, stuck, cancelled and explicitly cancelled workflows never unlock writes", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const toolBefore = createToolBeforeHook(deps)
    let call = 0
    const write = () => toolBefore(
      { tool: "write", sessionID: S, callID: `interactive-write-${++call}` } as any,
      { args: { filePath: "new.ts", content: "unsafe" } },
    )

    await expect(write()).rejects.toThrow(/read-only without an owned active plan workflow/)
    await toolBefore({ tool: "read", sessionID: S, callID: "interactive-read" } as any, { args: { filePath: "README.md" } })
    await toolBefore({ tool: "bash", sessionID: S, callID: "interactive-safe-bash" } as any, { args: { command: "git diff" } })
    await expect(toolBefore(
      { tool: "bash", sessionID: S, callID: "interactive-unsafe-bash" } as any,
      { args: { command: "rm -rf src" } },
    )).rejects.toThrow(/read-only without an owned active plan workflow/)

    mkdirSync(sessionDir(wt.worktree, OTHER), { recursive: true })
    const foreign = writeWorkflow(wt.worktree, newWorkflow(OTHER, currentOwner(), "keyword", "foreign request"))
    await runUserTurn(deps, "Try to start another request", { id: "interactive_foreign" })
    expect(readWorkflow(wt.worktree)?.id).toBe(foreign.id)
    await expect(write()).rejects.toThrow(/read-only without an owned active plan workflow/)

    const stuck = writeWorkflow(wt.worktree, {
      ...newWorkflow(S, currentOwner(), "keyword", "stuck request"),
      phase: "stuck",
      stuckCause: "tasks_failed",
    })
    await expect(write()).rejects.toThrow(/read-only without an owned active plan workflow/)
    expect(readWorkflow(wt.worktree)?.id).toBe(stuck.id)

    writeWorkflow(wt.worktree, { ...stuck, phase: "cancelled" })
    await expect(write()).rejects.toThrow(/read-only without an owned active plan workflow/)

    writeWorkflow(wt.worktree, newWorkflow(S, currentOwner(), "keyword", "cancel request"))
    await runCommand(deps, CANCEL_COMMAND, "", CANCEL_TEMPLATE)
    expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
    await expect(write()).rejects.toThrow(/read-only without an owned active plan workflow/)
  })

  test("interactive mode off retains legacy no-workflow tool behavior", async () => {
    const deps = makeDeps(client, wt.worktree)
    await runUserTurn(deps, "Please explain this code.", { id: "interactive_off" })
    expect(readWorkflow(wt.worktree)).toBeNull()
    await createToolBeforeHook(deps)(
      { tool: "write", sessionID: S, callID: "noninteractive-write" } as any,
      { args: { filePath: "legacy.ts", content: "legacy" } },
    )
  })
})
