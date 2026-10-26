import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import type { CliTransportOptions } from "../src/hosts/cli-transport.ts"
import type { ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { createTaskWorktree } from "../src/orchestration/worktree.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let fixture: ReturnType<typeof tempGitWorktree> | undefined
let child: Awaited<ReturnType<typeof createTaskWorktree>> = null
const previousConfigHome = process.env.XDG_CONFIG_HOME
afterEach(async () => {
  await child?.remove()
  child = null
  fixture?.cleanup()
  fixture = undefined
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousConfigHome
})

async function dispatch(runtime: ExecutionRuntime, cwd: string, id: string) {
  const claim = runtime.runs.claim("config-origin-session", runtime.instance, process.pid)
  const policy = runtime.policy.resolve("worker")
  const base = {
    executionID: id, supervisorSessionID: claim.ownerSession, taskID: id, attemptID: id,
    generation: claim.generation, role: "worker" as const, title: "Read the fixture", cwd,
    text: "Read README.md and finish.", deadlineAt: Date.now() + 10_000, policy,
  }
  const request: ExecutionRequest = { ...base, handlers: runtime.policy.handlers(base) }
  runtime.runs.registerIntent(claim, {
    executionId: id, ownerSession: claim.ownerSession, taskId: id, attemptId: id,
    generation: claim.generation, role: "worker", cwd, policyID: policy.id,
    kind: "host", engine: runtime.host.identity.engine, profile: "legacy-unowned",
    controlProfile: runtime.host.identity.controlProfile,
  })
  const result = await (await runtime.host.prepare(request)).run()
  runtime.runs.recordTerminal(claim, id, { outcome: result.status, quiescentAt: Date.now() })
  runtime.runs.release(claim)
  return result
}

for (const combo of [false, true]) {
  test(`isolated ${combo ? "cloud-anchor local route" : "local worker"} retains source config and reloads resets`, async () => {
    fixture = tempGitWorktree({ "README.md": "fixture\n", ".gitignore": ".otter/\n" })
    const root = realpathSync(fixture.worktree)
    process.env.XDG_CONFIG_HOME = join(fixture.stateHome, "config")
    mkdirSync(join(process.env.XDG_CONFIG_HOME, "otter"), { recursive: true })
    writeFileSync(join(process.env.XDG_CONFIG_HOME, "otter", "otter.jsonc"), JSON.stringify({
      local_model: { keep_alive: "5m", context_input_tokens: 16384 },
    }))
    mkdirSync(join(root, ".otter"), { recursive: true })
    const configPath = join(root, ".otter", "otter.jsonc")
    const save = (local_model: object) => writeFileSync(configPath, JSON.stringify({ local_model }))
    save({ keep_alive: "0", context_input_tokens: 4096 })
    child = await createTaskWorktree(root, "config-origin-session", "config-origin-workflow", [])
    expect(child).toBeDefined()
    expect(existsSync(join(child!.path, ".otter", "otter.jsonc"))).toBe(false)
    const calls: CliTransportOptions[] = []
    const runtime = createCliRuntime({
      worktree: root, engine: combo ? "claude" : "local", model: "fixture-model",
      ...(combo ? { routes: { worker: { engine: "local" as const, model: "fixture-local" } } } : {}),
      createTransport(options) {
        calls.push(options)
        return {
          async run() {
            const first = calls.length === 1
            const text = JSON.stringify(first
              ? { type: "tool", name: "read", input: { path: "README.md" } }
              : { type: "final", text: "done" })
            options.onText?.(text)
            if (first) save({ keep_alive: null, context_input_tokens: 16384 })
            return { status: "completed", text, quiescent: true }
          },
          async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
          async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture" } },
        }
      },
    })
    expect((await dispatch(runtime, child!.path, "first")).status).toBe("completed")
    expect(calls.map(call => call.localKeepAlive)).toEqual(["0", undefined])
    expect(calls.every(call => call.engine === "local" && call.prompt.includes("Input estimate limit: 4096"))).toBe(true)
    // The budget is fixed within an execution, then reloaded on the next execution (bounded by the worker role).
    expect((await dispatch(runtime, child!.path, "second")).status).toBe("completed")
    expect(calls[2]!.prompt).toContain("Input estimate limit: 5120")
    expect(calls[2]!.localKeepAlive).toBeUndefined()
    // Worker-created config cannot replace the originating project's live settings.
    mkdirSync(join(child!.path, ".otter"), { recursive: true })
    writeFileSync(join(child!.path, ".otter", "otter.jsonc"), JSON.stringify({
      local_model: { keep_alive: "-1", context_input_tokens: 65536 },
    }))
    save({ keep_alive: "0", context_input_tokens: 4096 })
    expect((await dispatch(runtime, child!.path, "third")).status).toBe("completed")
    expect(calls[3]!.prompt).toContain("Input estimate limit: 4096")
    expect(calls[3]!.localKeepAlive).toBe("0")
  })
}
