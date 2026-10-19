import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { attachAdmission, effectiveHold, holdAdmission, rebindAdmissionModel } from "../src/sessions/admission.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { openSession, readSessionMetadata, replaySession } from "../src/sessions/store.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { fullScript, scriptedRuntime } from "./workflow-fixture.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { stopHeartbeat(); wt.cleanup() })
const S = "rebind_session"
const routes = { architect: { engine: "codex", model: "gpt-5.6-sol" } } as const

describe("in-place model rebind", () => {
  test("durably changes model and routes of the current attachment and keeps identity, epoch and admission", () => {
    const { runtime } = scriptedRuntime(wt.worktree, fullScript())
    const store = attachAdmission(runtime, S, { engine: "local", model: "model-a" })
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    const changed = rebindAdmissionModel(runtime, S, store.epoch, { engine: "local", model: "model-b", routes })
    expect(changed.from).toEqual({ engine: "local", model: "model-a" })
    expect(changed.to).toEqual({ engine: "local", model: "model-b", routes })
    expect(readSessionMetadata(wt.worktree, S)).toMatchObject({ engine: "local", model: "model-b", routes, held: false })
    expect(store.metadata).toMatchObject({ model: "model-b", routes })
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    // clearing routes is a rebind too
    rebindAdmissionModel(runtime, S, store.epoch, { engine: "local", model: "model-b" })
    expect(readSessionMetadata(wt.worktree, S)?.routes).toBeUndefined()
  })

  test("refuses an engine change, a stale epoch, a held session and unsettled activity", () => {
    const { runtime } = scriptedRuntime(wt.worktree, fullScript())
    const store = attachAdmission(runtime, S, { engine: "local", model: "model-a" })
    expect(() => rebindAdmissionModel(runtime, S, store.epoch, { engine: "codex", model: "gpt-5-codex" })).toThrow("engine cannot change")
    expect(() => rebindAdmissionModel(runtime, S, "00000000-0000-4000-8000-000000000000", { engine: "local", model: "model-b" })).toThrow("not owned")
    expect(() => rebindAdmissionModel(runtime, "other_session", store.epoch, { engine: "local", model: "model-b" })).toThrow("not owned")
    const release = beginExecutionActivity(runtime, S, "review")!
    expect(() => rebindAdmissionModel(runtime, S, store.epoch, { engine: "local", model: "model-b" })).toThrow("still active")
    release()
    holdAdmission(wt.worktree, S, "test-hold")
    expect(() => rebindAdmissionModel(runtime, S, store.epoch, { engine: "local", model: "model-b" })).toThrow("held")
    expect(readSessionMetadata(wt.worktree, S)).toMatchObject({ model: "model-a" })
  })

  test("the store refuses an engine change and the model-rebind record is validated, bounded and replayed", () => {
    const store = openSession(wt.worktree, "store_rebind", { engine: "local", model: "model-a" })
    expect(() => store.rebindModel({ engine: "codex", model: "gpt-5-codex" })).toThrow("engine is immutable")
    store.rebindModel({ engine: "local", model: "model-b" })
    const good = { from: { engine: "local", model: "model-a" }, to: { engine: "local", model: "model-b", routes }, workflowID: "wf-1" }
    store.append("model-rebind", good)
    for (const bad of [{}, { from: good.from }, { ...good, extra: 1 }, { ...good, to: { engine: "local" } }, { ...good, workflowID: "x".repeat(600) }, { ...good, to: { engine: "local", model: "m", routes: { bogus: 1 } } }]) {
      expect(() => store.append("model-rebind", bad as never)).toThrow()
    }
    expect(replaySession(wt.worktree, "store_rebind", { kind: "model-rebind" }).records.map(record => record.data)).toEqual([good])
    store.release({ workflowQuiescent: true, evidence: "fixture", workflowID: null, revision: null })
    expect(readSessionMetadata(wt.worktree, "store_rebind")?.model).toBe("model-b")
    expect(openSession(wt.worktree, "store_rebind", { engine: "local", model: "model-b" }).restored).toBe(true)
  })
})
