// AC0.4/AC0.5: the §5.4 planning-boundary tool allowlist and the executing forced-resume guard, enforced in
// tool.execute.before. Owning session only; other sessions and no-workflow sessions are unaffected.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { newWorkflow, readEvents, writeWorkflow } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_owner"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
})
afterEach(() => wt.cleanup())

const before = (tool: string, args: any, sessionID = S, callID = "c1") => ({ input: { tool, sessionID, callID }, output: { args } })
const callArgs = (b: ReturnType<typeof before>): [any, any] => [b.input, b.output]

function putWorkflow(phase: string, patch: Record<string, unknown> = {}) {
  let wf = newWorkflow(S, currentOwner(), "command", "do the thing")
  wf = { ...wf, phase: phase as any, ...patch }
  return writeWorkflow(wt.worktree, wf)
}

describe("planning boundary (AC0.4)", () => {
  const DENIED_TOOLS = ["edit", "write", "multiedit", "patch", "apply_patch", "delegate", "task", "webfetch", "mcp_foo_write"]
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
      putWorkflow(phase)
      const deps = makeDeps(client, wt.worktree)
      const hook = createToolBeforeHook(deps)
      for (const tool of DENIED_TOOLS) {
        await expect(hook(...callArgs(before(tool, { filePath: "x", path: "x" })))).rejects.toThrow(
          'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
        )
      }
    })

    test(`allows allowlisted tools in ${phase}`, async () => {
      const wf = putWorkflow(phase)
      const deps = makeDeps(client, wt.worktree)
      const hook = createToolBeforeHook(deps)
      for (const tool of ALLOWED_TOOLS) {
        await hook(...callArgs(before(tool, {})))
      }
      // events.jsonl has no boundary_denied entries for the allowed calls
      const events = readEvents(wt.worktree, wf.id)
      expect(events.filter((e) => e.type === "boundary_denied")).toHaveLength(0)
    })

    test(`bash argv policy applies in ${phase}`, async () => {
      putWorkflow(phase)
      const deps = makeDeps(client, wt.worktree)
      const hook = createToolBeforeHook(deps)
      for (const command of DENIED_BASH) {
        await expect(hook(...callArgs(before("bash", { command })))).rejects.toThrow(
          'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
        )
      }
      for (const command of ALLOWED_BASH) {
        await hook(...callArgs(before("bash", { command })))
      }
    })
  }

  for (const cause of ["plan_invalid", "no_submission"]) {
    test(`denies in stuck(${cause})`, async () => {
      putWorkflow("stuck", { stuckCause: cause })
      const deps = makeDeps(client, wt.worktree)
      const hook = createToolBeforeHook(deps)
      await expect(hook(...callArgs(before("write", { filePath: "x" })))).rejects.toThrow(/planning phase/)
      await hook(...callArgs(before("read", {})))
    })
  }

  test("appends a boundary_denied event with the tool name", async () => {
    const wf = putWorkflow("planning")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    await expect(hook(...callArgs(before("write", { filePath: "x" })))).rejects.toThrow()
    const events = readEvents(wt.worktree, wf.id)
    const denied = events.filter((e) => e.type === "boundary_denied")
    expect(denied).toHaveLength(1)
    expect(denied[0]!.actor).toBe("model_tool")
    expect(denied[0]!.data).toEqual({ tool: "write" })
  })

  test("a non-owning session is unaffected", async () => {
    putWorkflow("planning")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    await hook(...callArgs(before("write", { filePath: "x" }, OTHER)))
    await hook(...callArgs(before("bash", { command: "rm x" }, OTHER)))
  })

  test("a session with no active workflow is unaffected", async () => {
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    await hook(...callArgs(before("write", { filePath: "x" })))
    await hook(...callArgs(before("bash", { command: "rm x" })))
  })

  test("disabling guard.plan_boundary lets every tool through", async () => {
    putWorkflow("planning")
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["guard.plan_boundary"] })
    const hook = createToolBeforeHook(deps)
    await hook(...callArgs(before("write", { filePath: "x" })))
    await hook(...callArgs(before("bash", { command: "rm x" })))
  })

  test("disabling the flow feature (config.flow.enabled=false) lets every tool through", async () => {
    putWorkflow("planning")
    const deps = makeDeps(client, wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } })
    const hook = createToolBeforeHook(deps)
    await hook(...callArgs(before("write", { filePath: "x" })))
  })
})

describe("forced resume in executing (AC0.5)", () => {
  test("delegate with tasks is refused", async () => {
    putWorkflow("executing")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    await expect(
      hook(...callArgs(before("delegate", { tasks: [{ title: "x" }] }))),
    ).rejects.toThrow("lca: an approved plan is running; call delegate with resume:true only")
  })

  test("delegate with no args (implicit empty tasks, no resume) is refused", async () => {
    putWorkflow("executing")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    await expect(hook(...callArgs(before("delegate", {})))).rejects.toThrow(
      "lca: an approved plan is running; call delegate with resume:true only",
    )
  })

  test("delegate with resume:true and a re-sent task list resumes and drops the list", async () => {
    putWorkflow("executing")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    const [input, output] = callArgs(before("delegate", { resume: true, tasks: [{ title: "x" }] }))
    await hook(input, output)
    expect(output.args).toEqual({ resume: true })
  })

  test("delegate with resume:true and no tasks passes", async () => {
    putWorkflow("executing")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    await hook(...callArgs(before("delegate", { resume: true })))
    await hook(...callArgs(before("delegate", { resume: true, tasks: [] })))
  })

  test("main cannot implement the approved plan itself: writes and mutating bash are refused in executing", async () => {
    putWorkflow("executing")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    for (const [tool, args] of [["write", { filePath: "x" }], ["edit", { filePath: "x" }], ["apply_patch", { patchText: "x" }], ["bash", { command: "rm x" }], ["bash", { command: "python3 -m pytest" }]] as const) {
      await expect(hook(...callArgs(before(tool, { ...args })))).rejects.toThrow("lca: an approved plan is running")
    }
    await hook(...callArgs(before("read", { filePath: "x" })))
    await hook(...callArgs(before("bash", { command: "git status" })))
    await hook(...callArgs(before("lca_flow", { op: "status" })))
  })

  test("a non-owning session's delegate is unaffected in executing", async () => {
    putWorkflow("executing")
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    await hook(...callArgs(before("delegate", { tasks: [{ title: "x" }] }, OTHER)))
  })
})
