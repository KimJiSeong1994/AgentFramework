import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { createToolAfterHook, isErrorOutput } from "../src/hooks/tool-after.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { writeJsonAtomic, sessionInfoPath, writeModeState, readModeState, EMPTY_MODE } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_t"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
})
afterEach(() => wt.cleanup())

const before = (tool: string, args: any, callID: string) => ({ input: { tool, sessionID: S, callID }, output: { args } })
const after = (tool: string, args: any, callID: string, output: string, metadata: any = {}) => ({
  input: { tool, sessionID: S, callID, args },
  output: { title: tool, output, metadata },
})
const toolErrorEvent = (callID: string, error: string) => ({
  event: { type: "message.part.updated", properties: { part: { id: "p", sessionID: S, messageID: "m", type: "tool", callID, tool: "write", state: { status: "error", error, input: {}, time: { start: 0, end: 1 } } } } } as any,
})

describe("tool.execute.before", () => {
  test("blocks the (limit+1)th identical failing call with a model-facing message", async () => {
    const deps = makeDeps(client, wt.worktree)
    const hookBefore = createToolBeforeHook(deps)
    const hookEvent = createEventHook(deps)
    const args = { filePath: "/x/a.ts", content: "hello" }
    const c1 = before("write", args, "c1")
    await hookBefore(c1.input, c1.output)
    await hookEvent(toolErrorEvent("c1", "Error: File already exists: /x/a.ts"))
    const c2 = before("write", { content: "hello", filePath: "/x/a.ts" }, "c2")
    await hookBefore(c2.input, c2.output)
    await hookEvent(toolErrorEvent("c2", "Error: File already exists: /x/a.ts"))
    const c3 = before("write", args, "c3")
    await expect(hookBefore(c3.input, c3.output)).rejects.toThrow(
      /^lca: blocked repeated call to write with identical arguments \(3x\)\. The previous attempts failed with: Error: File already exists: \/x\/a\.ts Change the approach/,
    )
    expect(deps.logs).toContain("blocked repeated call")
  })

  test("a successful identical call (tool.execute.after) resets the counter", async () => {
    const deps = makeDeps(client, wt.worktree)
    const hookBefore = createToolBeforeHook(deps)
    const hookAfter = createToolAfterHook(deps)
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const c = before("read", { filePath: "/x/a.ts" }, id)
      await hookBefore(c.input, c.output)
      const a = after("read", { filePath: "/x/a.ts" }, id, "00001| ok")
      await hookAfter(a.input, a.output)
    }
  })

  test("guard.repeat can be disabled", async () => {
    const hook = createToolBeforeHook(makeDeps(client, wt.worktree, { disabled_hooks: ["guard.repeat"] }))
    for (const id of ["1", "2", "3", "4"]) {
      const c = before("write", { a: 1 }, id)
      await hook(c.input, c.output)
    }
  })

  test("task is blocked for non-main agents, allowed for main / unknown", async () => {
    const hook = createToolBeforeHook(makeDeps(client, wt.worktree))
    const c = before("task", { description: "x", prompt: "y", subagent_type: "worker" }, "c1")
    await hook(c.input, c.output) // no session.json → allowed
    writeJsonAtomic(sessionInfoPath(wt.worktree, S), { agent: "main", createdAt: 1 })
    await hook(before("task", {}, "c2").input, { args: {} })
    writeJsonAtomic(sessionInfoPath(wt.worktree, S), { agent: "worker", createdAt: 1 })
    await expect(hook(before("task", {}, "c3").input, { args: {} })).rejects.toThrow(/lca: the task tool is only available to the main agent/)
  })
})

describe("tool.execute.after", () => {
  test("isErrorOutput markers", () => {
    expect(isErrorOutput("Error: nope")).toBe(true)
    expect(isErrorOutput("error: nope")).toBe(true)
    expect(isErrorOutput("✗ failed")).toBe(true)
    expect(isErrorOutput("Failed to run")).toBe(true)
    expect(isErrorOutput("Errors were logged: 0")).toBe(false)
    expect(isErrorOutput("all good")).toBe(false)
  })

  test("trims read output and sets metadata.lca", async () => {
    const deps = makeDeps(client, wt.worktree, { guards: { ...makeDeps(client, wt.worktree).config.guards, read_max_lines: 5 } })
    const hook = createToolAfterHook(deps)
    const a = after("read", { filePath: "f" }, "c1", Array.from({ length: 50 }, (_, i) => `${i}`).join("\n"), { preview: "x" })
    await hook(a.input, a.output)
    expect(a.output.output.split("\n").length).toBe(6)
    expect(a.output.output).toContain("[lca: trimmed 45 lines")
    expect(a.output.metadata).toEqual({ preview: "x", lca: { trimmed: true, hinted: false } })
  })

  test("appends the recovery hint after trimming so it is never cut", async () => {
    const deps = makeDeps(client, wt.worktree, { guards: { ...makeDeps(client, wt.worktree).config.guards, read_max_lines: 3 } })
    const hook = createToolAfterHook(deps)
    const body = "zsh: command not found: foo\n" + Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n")
    const a = after("bash", { command: "foo" }, "c1", body)
    await hook(a.input, a.output)
    expect(a.output.output.endsWith("\n\n[lca hint] Check the tool exists with `which`; do not retry the same command.")).toBe(true)
    expect(a.output.output).toContain("[lca: trimmed")
    expect(a.output.metadata.lca).toEqual({ trimmed: true, hinted: true })
  })

  test("edit/write outputs are hinted but never trimmed", async () => {
    const hook = createToolAfterHook(makeDeps(client, wt.worktree))
    const a = after("write", { filePath: "f" }, "c1", "Error: File already exists: f")
    await hook(a.input, a.output)
    expect(a.output.output).toBe("Error: File already exists: f\n\n[lca hint] Use the edit tool with oldString/newString, or read the file first.")
    expect(a.output.metadata.lca).toEqual({ trimmed: false, hinted: true })
  })

  test("error-looking output counts as a failure for the repeat guard", async () => {
    const deps = makeDeps(client, wt.worktree)
    const hookBefore = createToolBeforeHook(deps)
    const hookAfter = createToolAfterHook(deps)
    for (const id of ["c1", "c2"]) {
      const c = before("bash", { command: "foo" }, id)
      await hookBefore(c.input, c.output)
      const a = after("bash", { command: "foo" }, id, "Error: command not found: foo")
      await hookAfter(a.input, a.output)
    }
    const c3 = before("bash", { command: "foo" }, "c3")
    await expect(hookBefore(c3.input, c3.output)).rejects.toThrow(/failed with: Error: command not found: foo/)
  })

  test("a successful call resets loop failures when active", async () => {
    writeModeState(wt.worktree, S, { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: Date.now(), failures: 3 })
    const hook = createToolAfterHook(makeDeps(client, wt.worktree))
    const a = after("read", {}, "c1", "ok")
    await hook(a.input, a.output)
    expect(readModeState(wt.worktree, S).failures).toBe(0)
  })

  test("guard.trim and guard.recover can be disabled independently", async () => {
    const hook = createToolAfterHook(makeDeps(client, wt.worktree, { disabled_hooks: ["guard.trim", "guard.recover"], guards: { ...makeDeps(client, wt.worktree).config.guards, read_max_lines: 2 } }))
    const body = "Error: File already exists\na\nb\nc\nd"
    const a = after("write", {}, "c1", body)
    await hook(a.input, a.output)
    expect(a.output.output).toBe(body)
    expect(a.output.metadata.lca).toEqual({ trimmed: false, hinted: false })
  })

  test("relativizePaths strips worktree and directory prefixes, longest first", async () => {
    const { relativizePaths } = await import("../src/hooks/tool-after.ts")
    const out = relativizePaths("/w/sub/a.ts\n/w/b.ts\n/other/c.ts", ["/w", "/w/sub"])
    expect(out).toBe("a.ts\nb.ts\n/other/c.ts")
  })
})
