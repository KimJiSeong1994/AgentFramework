// D3: legacy plan keywords ("plan mode", "ralplan", "hyperplan", "계획부터", "계획 모드") map to §5.3 /plan with
// entry "keyword", actor user_keyword, when flow is on (chat-message.ts, the plan-keyword branch below
// handleWorkflowTurn). Informational questions are still suppressed unless `force:`/`!`; flow.enabled=false keeps
// the legacy <otter-mode name="plan"> path untouched; an active workflow in the same session gets a notice only
// (handleWorkflowTurn); a foreign session's workflow is never replaced, regardless of owner liveness.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { stripModeKeywords } from "../src/modes/detect.ts"
import { hasFlowSuffix, hasModeSuffix } from "../src/modes/instructions.ts"
import { activeWorkflow, eventsPath, newWorkflow, readEvents, readWorkflow, workflowPath, type Workflow, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readModeState, sessionDir } from "../src/state/store.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let fixtureSession: ReturnType<typeof admitFixtureSession>

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
})
afterEach(() => {
  stopHeartbeat()
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
})

function putWorkflow(sessionID: string, patch: Record<string, unknown> = {}): Workflow {
  const owner = sessionID === S ? currentOwner(Date.now(), fixtureSession.epoch) : currentOwner()
  const wf = { ...newWorkflow(sessionID, owner, "command", "an earlier request", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf as Workflow))
}

async function sendText(text: string, sessionID = S, deps = makeDeps(client, wt.worktree)): Promise<string> {
  const native = await createNativeToolFixture(deps, { sessionID })
  const { parts } = await native.deliverUserTurn({ text })
  const output = parts.find((part) => part.type === "text")
  if (!output || output.type !== "text") throw new Error("native user turn did not return a text part")
  return output.text
}

const KEYWORD_MESSAGES: Array<[string, string]> = [
  ["plan mode", "plan mode: add a login button"],
  ["ralplan", "ralplan: add a login button"],
  ["hyperplan", "hyperplan please add a login button"],
  ["계획부터", "계획부터 로그인 버튼 추가해줘"],
  ["계획 모드", "계획 모드로 로그인 버튼 추가해줘"],
]

describe("legacy plan keyword -> §5.3 keyword workflow (D3)", () => {
  for (const [label, text] of KEYWORD_MESSAGES) {
    test(`'${label}' + request starts a workflow: entry keyword, request without the keyword, actor user_keyword, flow suffix only, no legacy mode state`, async () => {
      const resultText = await sendText(text)
      const wf = readWorkflow(wt.worktree, S)!
      expect(wf.entry).toBe("keyword")
      expect(wf.sessionID).toBe(S)
      expect(wf.phase).toBe("planning")
      const expectedRequest = stripModeKeywords(text).trim() || "(no request text given)"
      expect(wf.request).toBe(expectedRequest)
      expect(wf.request.toLowerCase()).not.toContain(label.toLowerCase())

      const events = readEvents(wt.worktree, wf.id, S)
      const created = events.find((e) => e.type === "created")
      expect(created?.actor).toBe("user_keyword")

      expect(hasFlowSuffix(resultText)).toBe(true)
      expect(hasModeSuffix(resultText)).toBe(false)

      const mode = readModeState(wt.worktree, S)
      expect(mode.active).toBe(false)
      expect(mode.mode).toBe("none")
    })
  }

  test("an informational question about the keyword ('what is ralplan?') starts no workflow", async () => {
    const resultText = await sendText("what is ralplan?")
    expect(activeWorkflow(wt.worktree, S)).toBeNull()
    expect(hasFlowSuffix(resultText)).toBe(false)
  })

  test("force: bypasses informational suppression and starts a workflow", async () => {
    await sendText("force: what is ralplan?")
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.entry).toBe("keyword")
    expect(wf.sessionID).toBe(S)
  })

  test("flow.enabled=false: the legacy <otter-mode name=\"plan\"> suffix runs instead, no workflow", async () => {
    const deps = makeDeps(client, wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } })
    const resultText = await sendText("ralplan: add a login button", S, deps)
    expect(activeWorkflow(wt.worktree, S)).toBeNull()
    expect(hasModeSuffix(resultText)).toBe(true)
    expect(resultText).toContain('<otter-mode name="plan">')
    const mode = readModeState(wt.worktree, S)
    expect(mode.active).toBe(true)
    expect(mode.mode).toBe("plan")
  })

  test("active workflow in the same session + keyword -> notice only, no second workflow", async () => {
    const wf = putWorkflow(S, { phase: "planning" })
    const resultText = await sendText("ralplan: do something else")
    expect(resultText).toContain(`plan is off while plan workflow ${wf.id} is active; /cancel first.`)
    expect(hasFlowSuffix(resultText)).toBe(true)
    expect(hasModeSuffix(resultText)).toBe(false)
    const after = readWorkflow(wt.worktree, S)!
    expect(after.id).toBe(wf.id)
    expect(after.phase).toBe("planning")
  })

  test.each(["live", "dead"])("a %s foreign workflow stays unchanged while this session starts independently", async liveness => {
    mkdirSync(sessionDir(wt.worktree, OTHER), { recursive: true })
    const old = putWorkflow(OTHER, liveness === "dead" ? { phase: "planning", owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } } : { phase: "planning" })
    const workflowBefore = readFileSync(workflowPath(wt.worktree, OTHER))
    const eventsBefore = readEvents(wt.worktree, old.id, OTHER)
    const resultText = await sendText("ralplan: add a login button", S)
    expect(hasFlowSuffix(resultText)).toBe(true)
    const own = readWorkflow(wt.worktree, S)!
    expect(own.sessionID).toBe(S)
    expect(own.id).not.toBe(old.id)
    expect(readFileSync(workflowPath(wt.worktree, OTHER))).toEqual(workflowBefore)
    expect(readEvents(wt.worktree, old.id, OTHER)).toEqual(eventsBefore)
    expect(client.calls.length).toBe(0)
  })
})
