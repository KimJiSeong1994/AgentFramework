import { afterEach, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { ensureHeartbeat, requestStop, stopHeartbeat } from "../src/flow/runtime.ts"
import { readAnyWorkflowChecked, readEvents, readHeartbeat } from "../src/flow/state.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost } from "../src/hosts/types.ts"
import { admissionFence, attachAdmission, effectiveHold, holdAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { startDeepInterview } from "../src/workflows/deep-interview-driver.ts"
import { startRalplan } from "../src/workflows/ralplan-driver.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let fixture: ReturnType<typeof tempGitWorktree> | undefined
const stores: SessionStore[] = []
afterEach(() => {
  stopHeartbeat()
  for (const store of stores.splice(0)) {
    try { store.release({ workflowQuiescent: true, evidence: "isolated fixture has no executions", workflowID: null, revision: null }) } catch {}
  }
  fixture?.cleanup()
})

function setup() {
  fixture = tempGitWorktree()
  const worktree = realpathSync(fixture.worktree)
  const host: ExecutionHost = {
    identity: { engine: "fixture", profile: "legacy-unowned" },
    async preflight() { throw new Error("no execution expected") },
    async prepare() { throw new Error("no execution expected") },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "no execution" } },
  }
  const runtime = createExecutionRuntime({ directory: worktree, worktree, config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, { planningOnlyMain: true })
  stores.push(attachAdmission(runtime, "ses_isolated_a", { engine: "fixture", model: "fixture" }))
  return runtime
}

test("new session starts independently; holds and stop commits stay in their session", () => {
  const runtime = setup()
  const a = startDeepInterview(runtime, stores[0]!.sessionID, "first session work")
  expect(a.ok).toBe(true)
  const fenceA = admissionFence(runtime.worktree, stores[0]!.sessionID)
  stores.push(attachAdmission(runtime, "ses_isolated_b", { engine: "fixture", model: "fixture" }))
  const b = startRalplan(runtime, stores[1]!.sessionID, "second session work")
  expect(b.ok).toBe(true)
  if (!a.ok || !b.ok) throw new Error("fixture start failed")
  expect(admissionFence(runtime.worktree, a.wf.sessionID)).toBe(fenceA)
  expect(readAnyWorkflowChecked(runtime.worktree, a.wf.sessionID).wf).toEqual(a.wf)
  expect(readAnyWorkflowChecked(runtime.worktree, b.wf.sessionID).wf).toEqual(b.wf)
  holdAdmission(runtime.worktree, a.wf.sessionID, "test hold")
  expect(effectiveHold(runtime.worktree, a.wf.sessionID)).toBe(true)
  expect(effectiveHold(runtime.worktree, b.wf.sessionID)).toBe(false)
  requestStop(runtime, b.wf.sessionID, "cancel", "test stop")
  expect(readAnyWorkflowChecked(runtime.worktree, a.wf.sessionID).wf).toEqual(a.wf)
  expect(readEvents(runtime.worktree, a.wf.id, a.wf.sessionID).some(e => e.type === "cancel_requested")).toBe(false)
  expect(readAnyWorkflowChecked(runtime.worktree, b.wf.sessionID).wf?.lastSeq).toBeGreaterThan(b.wf.lastSeq)
})

test("heartbeat timers survive activity and stopping in another session", async () => {
  const runtime = setup()
  const a = startDeepInterview(runtime, stores[0]!.sessionID, "first session")
  stores.push(attachAdmission(runtime, "ses_isolated_b", { engine: "fixture", model: "fixture" }))
  const b = startRalplan(runtime, stores[1]!.sessionID, "second session")
  if (!a.ok || !b.ok) throw new Error("fixture start failed")
  ensureHeartbeat(runtime, "fixture", undefined, 5, a.wf.sessionID)
  ensureHeartbeat(runtime, "fixture", undefined, 5, b.wf.sessionID)
  await Bun.sleep(40)
  expect(readHeartbeat(runtime.worktree, a.wf, a.wf.sessionID)).toBeNumber()
  expect(readHeartbeat(runtime.worktree, b.wf, b.wf.sessionID)).toBeNumber()
  const before = readHeartbeat(runtime.worktree, b.wf, b.wf.sessionID)
  stopHeartbeat(runtime.worktree, a.wf.sessionID)
  await Bun.sleep(40)
  expect(readHeartbeat(runtime.worktree, b.wf, b.wf.sessionID)).not.toEqual(before)
})
