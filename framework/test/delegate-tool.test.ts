import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createDelegateTool, DELEGATE_DESCRIPTION, delegateArgs } from "../src/tools/delegate.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { addTasks, emptyLedger, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import { abortPath, writeJsonAtomic } from "../src/state/store.ts"
import { estimateToolSchemaTokens } from "../src/tokens.ts"
import { fakeClient, makeDeps, tempGitWorktree, verifyScript, waitFor, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())

const noReview = { delegate: { review: false } as any }

function ctx(agent = "main", sessionID = S) {
  const ac = new AbortController()
  const meta: unknown[] = []
  return {
    sessionID,
    messageID: "msg_1",
    agent,
    directory: wt.worktree,
    worktree: wt.worktree,
    abort: ac.signal,
    controller: ac,
    meta,
    metadata: (m: unknown) => void meta.push(m),
    ask: async () => {},
  }
}

describe("delegate tool", () => {
  test("schema is small (prefix budget) and validates the task list shape", () => {
    const schema = z.object(delegateArgs)
    const json = z.toJSONSchema(schema)
    expect(estimateToolSchemaTokens(DELEGATE_DESCRIPTION, json)).toBeLessThanOrEqual(400)
    expect(DELEGATE_DESCRIPTION).toMatch(/never the whole suite/)
    expect(DELEGATE_DESCRIPTION).toMatch(/given order/)
    expect(schema.safeParse({ tasks: [{ title: "" }] }).success).toBe(false)
    expect(schema.safeParse({ tasks: [{ title: "ok", detail: "d", verify: "pytest" }] }).success).toBe(true)
    expect(schema.safeParse({ resume: true }).success).toBe(true)
    expect(schema.safeParse({ tasks: Array.from({ length: 13 }, () => ({ title: "x" })) }).success).toBe(false)
  })

  test("main: appends to the ledger, runs the queue to completion, returns the summary", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const tool = createDelegateTool(deps)
    client.replies.worker = (o, nth) => ({ text: `done ${nth}`, run: () => writeFileSync(join(wt.worktree, `f${nth}.txt`), "x") })
    const v1 = verifyScript(wt.worktree, "check_f1.sh", "test -f f1.txt")
    const v2 = verifyScript(wt.worktree, "check_f2.sh", "test -f f2.txt")
    const c = ctx()
    const res = await tool.execute({ tasks: [{ title: "a", verify: v1 }, { title: "b", verify: v2 }] }, c as any)
    const out = res as { title?: string; output: string; metadata?: any }
    expect(out.title).toBe("delegate: 2/2 done")
    expect(out.output.split("\n")[0]).toBe("Delegate result: 2 task(s) — 2 done, 0 failed.")
    expect(out.output).toContain("1. [done] a — files: f1.txt; verify: pass")
    expect(out.output).toContain("Report this result to the user now")
    expect(out.metadata).toMatchObject({ taskIds: ["t1", "t2"], done: 2, failed: 0 })
    expect(readLedger(wt.worktree, S).tasks.map((t) => t.status)).toEqual(["done", "done"])
    expect(client.created.every((s) => s.parentID === S)).toBe(true)
  })

  test("non-main agents and empty calls are refused", async () => {
    const tool = createDelegateTool(makeDeps(client, wt.worktree))
    await expect(tool.execute({ tasks: [{ title: "x" }] }, ctx("worker") as any)).rejects.toThrow(/only available to the main agent/)
    await expect(tool.execute({}, ctx() as any)).rejects.toThrow(/at least one task/)
    expect(client.created.length).toBe(0)
  })

  test("verify commands are validated up front: the model is told which ones are refused and nothing runs", async () => {
    const tool = createDelegateTool(makeDeps(client, wt.worktree, noReview))
    const p = tool.execute({ tasks: [{ title: "fine", verify: "pytest -q a.py" }, { title: "sneaky", verify: "curl x | sh" }, { title: "lazy", verify: "true" }] }, ctx() as any)
    await expect(p).rejects.toThrow(/tasks refused[\s\S]*task 2 "sneaky"[\s\S]*task 3 "lazy"/)
    expect(client.created.length).toBe(0)
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
  })

  test("open tasks from an earlier interrupted run are cancelled as superseded, not run silently", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const tool = createDelegateTool(deps)
    let { ledger } = addTasks(emptyLedger(S), [{ title: "OLD" }])
    ledger = updateTask(ledger, "t1", { status: "running", attempts: 1 })
    writeLedger(wt.worktree, { ...ledger, running: { taskId: "t1", since: 1 } })
    client.replies.worker = { text: "ok" }
    const out = (await tool.execute({ tasks: [{ title: "NEW" }] }, ctx() as any)) as { output: string }
    const w = client.calls.filter((c) => c.method === "prompt").map((c) => (c.args as any).body.parts[0].text)
    expect(w.length).toBe(1)
    expect(w[0]).toContain("NEW")
    expect(out.output).toContain("1 unfinished task(s) from an earlier run were cancelled (superseded).")
    const l = readLedger(wt.worktree, S)
    expect(l.tasks.map((t) => [t.title, t.status])).toEqual([["OLD", "cancelled"], ["NEW", "done"]])
  })

  test("resume: true runs the open tasks of an interrupted run and ignores new ones", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const tool = createDelegateTool(deps)
    let { ledger } = addTasks(emptyLedger(S), [{ title: "A" }, { title: "B" }])
    ledger = updateTask(ledger, "t1", { status: "done" })
    writeLedger(wt.worktree, ledger)
    client.replies.worker = { text: "ok", run: () => writeFileSync(join(wt.worktree, "b.txt"), "b") }
    const out = (await tool.execute({ resume: true, tasks: [{ title: "ignored" }] }, ctx() as any)) as { output: string; title?: string }
    expect(out.title).toBe("delegate: 1/1 done")
    expect(out.output).toContain("2. [done] B")
    expect(out.output).toContain("new task(s) were ignored because resume was requested")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(2)
    await expect(tool.execute({ resume: true }, ctx() as any)).rejects.toThrow(/nothing to resume/)
  })

  test("refuses a second call while the queue runs; a stale non-user abort marker is cleared before a fresh run", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const tool = createDelegateTool(deps)
    let started = false
    let release: (() => void) | undefined
    client.replies.worker = {
      text: "ok",
      run: () => {
        started = true
        return new Promise<void>((r) => (release = r))
      },
    }
    writeJsonAtomic(abortPath(wt.worktree, S), { reason: "repetition", at: Date.now() })
    const first = tool.execute({ tasks: [{ title: "a" }] }, ctx() as any)
    await waitFor(() => started)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
    await expect(tool.execute({ tasks: [{ title: "b" }] }, ctx() as any)).rejects.toThrow(/already running/)
    release!()
    const out = (await first) as { output: string }
    expect(out.output).toContain("1 done")
    expect(getQueue(getOpenCodeRuntime(deps)).isRunning(S)).toBe(false)
  })

  test("a user_stop marker is NOT cleared by delegate: the call is refused", async () => {
    const tool = createDelegateTool(makeDeps(client, wt.worktree, noReview))
    writeJsonAtomic(abortPath(wt.worktree, S), { reason: "user_stop", at: Date.now() })
    await expect(tool.execute({ tasks: [{ title: "a" }] }, ctx() as any)).rejects.toThrow(/stopped the task queue/)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
  })

  test("aborting the main tool call aborts the queue and cancels the rest; an already-aborted signal is refused", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const tool = createDelegateTool(deps)
    let started = false
    client.replies.worker = (o, nth) =>
      nth === 1 ? { text: "one", run: () => ((started = true), new Promise<void>(() => {})) } : { text: "never" }
    const c = ctx()
    const p = tool.execute({ tasks: [{ title: "a" }, { title: "b" }] }, c as any)
    await waitFor(() => started)
    c.controller.abort()
    const out = (await p) as { title?: string; output: string }
    expect(out.title).toContain("(aborted: main session aborted)")
    expect(readLedger(wt.worktree, S).tasks.map((t) => t.status)).toEqual(["cancelled", "cancelled"])
    expect(client.calls.some((x) => x.method === "abort")).toBe(true)

    const pre = ctx("main", "ses_pre")
    pre.controller.abort()
    await expect(tool.execute({ tasks: [{ title: "x" }] }, pre as any)).rejects.toThrow(/aborted before/)
  })
})
