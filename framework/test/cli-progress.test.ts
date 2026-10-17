import { describe, expect, test } from "bun:test"
import { createCliProgressPresenter, type CliHostActivity } from "../src/hosts/cli-progress.ts"

function capture() {
  const output: string[] = []
  const progress = createCliProgressPresenter(text => output.push(text))
  return { output, progress }
}

describe("CLI progress presenter", () => {
  test("renders bounded task and host lifecycle transitions while suppressing repeats", () => {
    const { output, progress } = capture()
    progress.tasks([
      { id: "t1", status: "pending", title: "Read the code carefully" },
      { id: "t2", status: "pending", title: "Review \u001b[31munsafe title\nwith a second line" },
    ])
    progress.waiting()
    progress.waiting()
    progress.host({ kind: "model-started", role: "main", execution: 1 })
    progress.host({ kind: "model-returned", role: "main", execution: 1, status: "completed" })
    progress.responseReceived()
    progress.waiting()
    progress.responseReceived()
    progress.queue("task start", { task: "t1", attempt: 1 })
    progress.queue("task start", { task: "t1", attempt: 1 })
    progress.queue("task verify started", { task: "t1", attempt: 1 })
    progress.queue("task verify started", { task: "t1", attempt: 1 })
    progress.queue("task verify", { task: "t1", ok: true })
    progress.queue("task verify", { task: "t1", ok: true })
    progress.host({ kind: "model-started", role: "worker", execution: 2 })
    progress.host({ kind: "tool-started", role: "worker", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-1", tool: "read" })
    progress.host({ kind: "tool-started", role: "worker", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-2", tool: "read" })
    progress.host({ kind: "tool-finished", role: "worker", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-1", tool: "read", outcome: "succeeded", ok: true })
    progress.host({ kind: "tool-finished", role: "worker", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-1", tool: "read", outcome: "succeeded", ok: true })
    progress.host({ kind: "tool-finished", role: "worker", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-2", tool: "read", outcome: "failed", ok: false })
    progress.host({ kind: "model-returned", role: "reviewer", execution: 3, status: "completed" })
    progress.queue("task finished", { task: "t1", status: "done" })
    progress.queue("task start", { task: "t2", attempt: 1 })
    progress.queue("task attempt failed", { task: "t2", attempt: 1 })
    progress.queue("task finished", { task: "t2", status: "failed" })
    progress.final({ workflowID: "wf_20261011_abcd", phase: "stuck", done: 1, failed: 1, cancelled: 0 })

    const rendered = output.join("")
    expect(rendered.match(/Waiting for the planning model/g)).toHaveLength(2)
    expect(rendered.match(/Planning model response received/g)).toHaveLength(2)
    expect(rendered.match(/t1 running \(attempt 1\)/g)).toHaveLength(1)
    expect(rendered.match(/t1 verification passed/g)).toHaveLength(1)
    expect(rendered.match(/started read tool/g)).toHaveLength(2)
    expect(rendered.match(/finished read tool/g)).toHaveLength(1)
    expect(rendered.match(/failed read tool/g)).toHaveLength(1)
    expect(rendered).toContain("Reviewer model response received.")
    expect(rendered).toContain("[tasks] t1 done.")
    expect(rendered).toContain("[tasks] t1 pending — Read the code carefully.")
    expect(rendered).toContain("[tasks] t2 pending — Review \\u001b[31munsafe title with a second line.")
    expect(rendered.match(/t1 verification started \(attempt 1\)/g)).toHaveLength(1)
    expect(rendered).toContain("[error] t2 attempt 1 failed; final task status is not yet settled.")
    expect(rendered).toContain("[tasks] t2 failed.")
    expect(rendered).toContain("[final] Workflow wf_20261011_abcd stuck; done 1, failed 1, cancelled 0.")
  })

  test("does not expose untrusted diagnostics, content, or invalid terminal text", () => {
    const { output, progress } = capture()
    const secret = "prompt credential \u001b[31mraw tool output"
    progress.tasks([{ id: "t1", status: "pending" }])
    progress.queue("task attempt failed", { task: "t1", attempt: 1, failure: secret, prompt: secret, output: secret })
    progress.queue("queue crashed", { error: secret, prompt: secret })
    progress.queue("task start", { task: `t1\u001b[2J`, attempt: 1 })
    progress.host({ kind: "model-returned", role: "reviewer", execution: 1, status: "failed" })
    progress.host({ kind: "tool-finished", role: "data-verifier", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-1", tool: "grep", outcome: "failed", ok: false })
    progress.final({ phase: `${secret}`, done: 0, failed: 1, cancelled: 0 })

    const rendered = output.join("")
    expect(rendered).not.toContain("credential")
    expect(rendered).not.toContain("raw tool output")
    expect(rendered).not.toContain("\\u001b")
    expect(rendered).not.toContain("[31m")
    expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain("[final]")
    expect(rendered).toContain("attempt 1 failed")
    expect(rendered).toContain("Approved task list (1 task):")
    expect(rendered).toContain("stopped unexpectedly")
    expect(rendered).toContain("[error] Reviewer model request failed.")
    expect(rendered).toContain("[error] Data verifier failed grep tool.")
  })

  test("observes validated structured activities without tool lines when disabled", () => {
    const output: string[] = []
    const observed: CliHostActivity[] = []
    const progress = createCliProgressPresenter(text => output.push(text), activity => observed.push(activity), { toolLines: false })
    const toolStarted: CliHostActivity = {
      kind: "tool-started", role: "worker", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-1", tool: "read",
    }
    const toolFinished: CliHostActivity = {
      kind: "tool-finished", role: "worker", execution: 2, taskID: "t1", executionID: "exec-2", callID: "call-1", tool: "read", outcome: "denied", ok: false,
    }
    progress.host({ kind: "model-started", role: "worker", execution: 2 })
    progress.host(toolStarted)
    progress.host(toolFinished)

    expect(observed).toEqual([
      { kind: "model-started", role: "worker", execution: 2 },
      toolStarted,
      toolFinished,
    ])
    expect(output).toEqual(["[activity] Worker model is working.\n"])
  })

  test("fullscreen main-model status stays out of chat without hiding errors or cancellation", () => {
    const output: string[] = []
    const observed: CliHostActivity[] = []
    const progress = createCliProgressPresenter(text => output.push(text), activity => observed.push(activity), { mainModelLines: false })
    progress.waiting()
    progress.host({ kind: "model-started", role: "main", execution: 1 })
    progress.host({ kind: "model-returned", role: "main", execution: 1, status: "completed" })
    progress.responseReceived()
    expect(output).toEqual([])
    expect(observed).toHaveLength(2)
    progress.host({ kind: "model-returned", role: "main", execution: 2, status: "failed" })
    progress.cancelRequested()
    expect(output.join("")).toContain("model request failed")
    expect(output.join("")).toContain("Cancellation requested; outcome is not yet settled")
    expect(observed).toHaveLength(3)
  })

  test("shows cancel-requested separately from settled task cancellation and buffers during approval", () => {
    const { output, progress } = capture()
    progress.tasks([{ id: "t1", status: "running" }])
    expect(output).toEqual(["[tasks] Approved task list (1 task):\n", "[tasks] t1 running.\n"])
    progress.suspend()
    progress.cancelRequested()
    progress.queue("task finished", { task: "t1", status: "cancelled" })
    expect(output).toEqual(["[tasks] Approved task list (1 task):\n", "[tasks] t1 running.\n"])
    progress.resume()
    expect(output.join("")).toContain("Cancellation requested; outcome is not yet settled.")
    expect(output.join("")).toContain("[tasks] t1 cancelled.")
    expect(output.join("")).toContain("[progress] ######################## 1/1 tasks | 1 cancelled | 100%")
    progress.taskSnapshot([{ id: "t1", status: "cancelled" }])
    expect(output.join("").match(/t1 cancelled/g)).toHaveLength(1)
  })

  test("tracks terminal changes beyond the former 64-task display limit", () => {
    const { output, progress } = capture()
    const tasks = Array.from({ length: 80 }, (_, index) => ({ id: `t${index + 1}`, status: "pending" as const }))
    progress.tasks(tasks)
    progress.queue("task start", { task: "t80", attempt: 1 })
    progress.queue("task finished", { task: "t80", status: "failed" })

    const rendered = output.join("")
    expect(rendered).toContain("Approved task list (80 tasks):")
    expect(rendered).toContain("[tasks] t80 running (attempt 1).")
    expect(rendered).toContain("[tasks] t80 failed.")
  })

  test("writer failures cannot escape lifecycle observers", () => {
    const progress = createCliProgressPresenter(() => { throw new Error("terminal failed") })
    expect(() => {
      progress.waiting()
      progress.host({ kind: "model-started", role: "worker", execution: 1 })
      progress.queue("task start", { task: "t1", attempt: 1 })
      progress.queue("task finished", { task: "t1", status: "failed" })
      progress.cancelRequested()
      progress.final({ phase: "failed", done: 0, failed: 1, cancelled: 0 })
      progress.error()
    }).not.toThrow()
  })
})
