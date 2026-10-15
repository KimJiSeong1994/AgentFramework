// AC0.4/AC0.5: the §5.4 planning-boundary tool allowlist and the executing forced-resume guard, enforced in
// tool.execute.before. Owning session only; other sessions and no-workflow sessions are unaffected.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { newWorkflow, readEvents, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { createBoundNativeToolChildFixture, createNativeToolFixture } from "./native-tool-fixture.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_owner"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let owner: ReturnType<typeof admitFixtureSession>
let other: ReturnType<typeof admitFixtureSession>

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  const deps = makeDeps(client, wt.worktree)
  owner = admitFixtureSession(deps, S)
  other = admitFixtureSession(deps, OTHER)
})
afterEach(() => {
  releaseFixtureSession(wt.worktree, owner)
  releaseFixtureSession(wt.worktree, other)
  wt.cleanup()
})

let callSequence = 0

async function nativeFixture(deps: ReturnType<typeof makeDeps>, sessionID = S) {
  const native = await createNativeToolFixture(deps, { sessionID })
  await native.acceptUserTurn()
  return native
}

async function invokeBefore(deps: ReturnType<typeof makeDeps>, native: Awaited<ReturnType<typeof nativeFixture>>, tool: string, args: Record<string, unknown>) {
  const call = native.primeCall({ tool, args, callID: `flow_boundary_${++callSequence}` })
  return createToolBeforeHook(deps)(call.input, call.output)
}

function putWorkflow(phase: string, patch: Record<string, unknown> = {}) {
  let wf = newWorkflow(S, currentOwner(Date.now(), owner.epoch), "command", "do the thing", "opencode")
  wf = { ...wf, phase: phase as any, ...patch }
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))
}

describe("planning boundary (AC0.4)", () => {
  const POLICY_DENIED_TOOLS = ["task", "webfetch", "mcp_foo_write"]
  const BOUNDARY_DENIED_TOOLS = ["edit", "write", "multiedit", "patch", "apply_patch", "delegate"]
  const ALLOWED_TOOLS = ["read", "glob", "grep", "list", "todowrite"]

  const DENIED_BASH = [
    "ls && rm -rf src",
    "ls; rm x",
    "cat a | sh",
    "echo x > f",
    "ls $(rm x)",
    "ls `rm x`",
    "find . -delete",
    "find . -exec rm {} +",
    "rg --pre sh x",
    "rg --pre=sh x",
    "rg --hostname-bin=sh x",
    "rg --hostname-bin sh x",
    "git diff --output=f",
    "git -c core.pager=sh log",
    "git -C .. status",
    "git log --ext-diff",
    "tail -f log",
    "python3 -c 1",
    "sh -c ls",
    "rm x",
    `echo "unbalanced`,
  ]
  const ALLOWED_BASH = ["git diff", "git log --oneline -5", 'rg -n "foo bar" src', "ls -la src", "cat README.md", "head -50 x.py", "wc -l x"]

  for (const phase of ["planning", "reviewing", "pending_approval"]) {
    test(`denies non-allowlisted tools in ${phase}`, async () => {
      const deps = makeDeps(client, wt.worktree)
      const native = await nativeFixture(deps)
      putWorkflow(phase)
      for (const tool of POLICY_DENIED_TOOLS) {
        await expect(invokeBefore(deps, native, tool, { filePath: "x", path: "x" })).rejects.toThrow(
          "lca: OpenCode tool call refused (disallowed-tool)",
        )
      }
      for (const tool of BOUNDARY_DENIED_TOOLS) {
        const args = tool === "delegate" ? { tasks: [{ title: "x" }] } : { filePath: "x", path: "x" }
        await expect(invokeBefore(deps, native, tool, args)).rejects.toThrow(
          'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
        )
      }
    })

    test(`allows allowlisted tools in ${phase}`, async () => {
      const deps = makeDeps(client, wt.worktree)
      const native = await nativeFixture(deps)
      const wf = putWorkflow(phase)
      for (const tool of ALLOWED_TOOLS) {
        await invokeBefore(deps, native, tool, {})
      }
      // events.jsonl has no boundary_denied entries for the allowed calls
      const events = readEvents(wt.worktree, wf.id)
      expect(events.filter((e) => e.type === "boundary_denied")).toHaveLength(0)
    })

    test(`bash argv policy applies in ${phase}`, async () => {
      const deps = makeDeps(client, wt.worktree)
      const native = await nativeFixture(deps)
      putWorkflow(phase)
      for (const command of DENIED_BASH) {
        await expect(invokeBefore(deps, native, "bash", { command })).rejects.toThrow(
          'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
        )
      }
      for (const command of ALLOWED_BASH) {
        await invokeBefore(deps, native, "bash", { command })
      }
    })
  }

  for (const cause of ["plan_invalid", "no_submission"]) {
    test(`denies in stuck(${cause})`, async () => {
      const deps = makeDeps(client, wt.worktree)
      const native = await nativeFixture(deps)
      putWorkflow("stuck", { stuckCause: cause })
      await expect(invokeBefore(deps, native, "write", { filePath: "x" })).rejects.toThrow(
        'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
      )
      await invokeBefore(deps, native, "read", {})
    })
  }

  test("appends a boundary_denied event with the tool name", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    const wf = putWorkflow("planning")
    await expect(invokeBefore(deps, native, "delegate", { tasks: [{ title: "x" }] })).rejects.toThrow(
      'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
    )
    const events = readEvents(wt.worktree, wf.id)
    const denied = events.filter((e) => e.type === "boundary_denied")
    expect(denied).toHaveLength(1)
    expect(denied[0]!.actor).toBe("model_tool")
    expect(denied[0]!.data).toEqual({ tool: "delegate" })
  })

  test("a non-owning session bypasses another session's workflow boundary", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps, OTHER)
    putWorkflow("planning")
    await invokeBefore(deps, native, "delegate", { tasks: [{ title: "x" }] })
    await invokeBefore(deps, native, "bash", { command: "git status" })
  })

  test("a session with no active workflow retains ordinary main-tool behavior", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    await invokeBefore(deps, native, "read", { filePath: "x" })
    await invokeBefore(deps, native, "bash", { command: "git status" })
  })

  test("disabling guard.plan_boundary disables workflow restrictions", async () => {
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["guard.plan_boundary"] })
    const native = await nativeFixture(deps)
    putWorkflow("planning")
    await invokeBefore(deps, native, "delegate", { tasks: [{ title: "x" }] })
    await invokeBefore(deps, native, "bash", { command: "git status" })
  })

  test("disabling the flow feature disables workflow restrictions", async () => {
    const deps = makeDeps(client, wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } })
    const native = await nativeFixture(deps)
    putWorkflow("planning")
    await invokeBefore(deps, native, "delegate", { tasks: [{ title: "x" }] })
  })

  test("a real bound worker is the positive write authority during planning", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "flow_boundary_worker", ownerSessionID: S, role: "worker",
    })
    try {
      putWorkflow("planning")
      // The workflow changed after the child's creation turn; deliver a fresh real worker turn so the call binds to current state.
      await child.native.acceptUserTurn()
      const call = child.native.primeCall({
        tool: "write",
        args: { filePath: "worker-output.ts", content: "export const workerOutput = true;\n" },
        callID: `flow_boundary_worker_${++callSequence}`,
      })
      await createToolBeforeHook(deps)(call.input, call.output)
    } finally {
      child.cleanup()
    }
  })
})

describe("forced resume in executing (AC0.5)", () => {
  test("delegate with tasks is refused", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    putWorkflow("executing")
    await expect(invokeBefore(deps, native, "delegate", { tasks: [{ title: "x" }] })).rejects.toThrow(
      "lca: an approved plan is running; call delegate with resume:true only",
    )
  })

  test("delegate with no args (implicit empty tasks, no resume) is refused", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    putWorkflow("executing")
    await expect(invokeBefore(deps, native, "delegate", {})).rejects.toThrow(
      "lca: an approved plan is running; call delegate with resume:true only",
    )
  })

  test("delegate with resume:true and a re-sent task list is refused without changing args", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    putWorkflow("executing")
    const hook = createToolBeforeHook(deps)
    const args = { resume: true, tasks: [{ title: "x" }] }
    const call = native.primeCall({ tool: "delegate", args, callID: `flow_boundary_${++callSequence}` })
    await expect(hook(call.input, call.output)).rejects.toThrow(
      "lca: delegate resume must omit tasks; retry with the exact approved resume arguments",
    )
    expect(call.output.args).toEqual(args)
  })

  test("delegate with resume:true and no tasks passes", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    putWorkflow("executing")
    await invokeBefore(deps, native, "delegate", { resume: true })
    await invokeBefore(deps, native, "delegate", { resume: true, tasks: [] })
  })

  test("main cannot implement the approved plan itself: writes and mutating bash are refused in executing", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    putWorkflow("executing")
    for (const [tool, args] of [["write", { filePath: "x" }], ["edit", { filePath: "x" }], ["apply_patch", { patchText: "x" }], ["bash", { command: "rm x" }], ["bash", { command: "python3 -m pytest" }]] as const) {
      await expect(invokeBefore(deps, native, tool, { ...args })).rejects.toThrow("lca: an approved plan is running")
    }
    await invokeBefore(deps, native, "read", { filePath: "x" })
    await invokeBefore(deps, native, "bash", { command: "git status" })
    await invokeBefore(deps, native, "lca_flow", { op: "status" })
  })

  test("a non-owning session's delegate is unaffected in executing", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps, OTHER)
    putWorkflow("executing")
    await invokeBefore(deps, native, "delegate", { tasks: [{ title: "x" }] })
  })
})
