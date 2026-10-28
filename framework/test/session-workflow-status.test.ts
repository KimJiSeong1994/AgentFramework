import { afterEach, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { newWorkflow, withFlowTransaction } from "../src/flow/state.ts"
import { statusJson } from "../src/flow/status.ts"
import { createStatusWatchState, watchTick } from "../src/hosts/status-watch.ts"
import { publishWorkflow, writeWorkflow } from "./commit-fixture.ts"
import { tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
afterEach(() => wt?.cleanup())

test("status and watch follow only the selected session's workflow", () => {
  wt = tempWorktree()
  const runtime = { worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }
  const create = (sessionID: string) => withFlowTransaction(wt.worktree, tx =>
    writeWorkflow(tx, newWorkflow(sessionID, currentOwner(), "command", sessionID, "opencode"), 1000), sessionID)
  const first = create("first")
  const second = create("second")
  expect(statusJson(runtime, "first").workflow?.id).toBe(first.id)
  expect(statusJson(runtime, "second").workflow?.id).toBe(second.id)
  expect(statusJson(runtime, "fresh").workflow).toBeNull()
  const watch = createStatusWatchState({ sessionID: "second" })
  expect(watchTick(watch, runtime, 1000).frame).toMatchObject({ status: { workflow: { id: second.id } } })
  publishWorkflow(wt.worktree, { ...first, lastSeq: 1 }, 1100, "first")
  expect(watchTick(watch, runtime, 1001).frame).toBeUndefined()
  publishWorkflow(wt.worktree, { ...second, lastSeq: 1 }, 1200, "second")
  expect(watchTick(watch, runtime, 1002).frame).toMatchObject({ status: { workflow: { id: second.id } } })
})
