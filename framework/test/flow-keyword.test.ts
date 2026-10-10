// D3: legacy plan keywords ("plan mode", "ralplan", "hyperplan", "계획부터", "계획 모드") map to §5.3 /plan with
// entry "keyword", actor user_keyword, when flow is on (chat-message.ts, the plan-keyword branch below
// handleWorkflowTurn). Informational questions are still suppressed unless `force:`/`!`; flow.enabled=false keeps
// the legacy <lca-mode name="plan"> path untouched; an active workflow in the same session gets a notice only
// (handleWorkflowTurn); a foreign session's dead owner is replaced via T20 then a fresh workflow starts for this
// session; a foreign live owner is refused with no mutation.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { stripModeKeywords } from "../src/modes/detect.ts"
import { hasFlowSuffix, hasModeSuffix } from "../src/modes/instructions.ts"
import { activeWorkflow, archivePath, eventsPath, newWorkflow, readEvents, readWorkflow, workflowPath, writeWorkflow, type Workflow, withFlowTransaction } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { readModeState, sessionDir } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
})
afterEach(() => wt.cleanup())

function putWorkflow(sessionID: string, patch: Record<string, unknown> = {}): Workflow {
  const wf = { ...newWorkflow(sessionID, currentOwner(), "command", "an earlier request", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf as Workflow))
}

async function sendText(text: string, sessionID = S, deps = makeDeps(client, wt.worktree)): Promise<string> {
  const hook = createChatMessageHook(deps)
  const part: any = { type: "text", text }
  await hook({ sessionID, agent: "main" } as any, { message: {} as any, parts: [part] })
  return part.text as string
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
      const wf = readWorkflow(wt.worktree)!
      expect(wf.entry).toBe("keyword")
      expect(wf.sessionID).toBe(S)
      expect(wf.phase).toBe("planning")
      const expectedRequest = stripModeKeywords(text).trim() || "(no request text given)"
      expect(wf.request).toBe(expectedRequest)
      expect(wf.request.toLowerCase()).not.toContain(label.toLowerCase())

      const events = readEvents(wt.worktree, wf.id)
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
    expect(activeWorkflow(wt.worktree)).toBeNull()
    expect(hasFlowSuffix(resultText)).toBe(false)
  })

  test("force: bypasses informational suppression and starts a workflow", async () => {
    await sendText("force: what is ralplan?")
    const wf = readWorkflow(wt.worktree)!
    expect(wf.entry).toBe("keyword")
    expect(wf.sessionID).toBe(S)
  })

  test("flow.enabled=false: the legacy <lca-mode name=\"plan\"> suffix runs instead, no workflow", async () => {
    const deps = makeDeps(client, wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } })
    const resultText = await sendText("ralplan: add a login button", S, deps)
    expect(activeWorkflow(wt.worktree)).toBeNull()
    expect(hasModeSuffix(resultText)).toBe(true)
    expect(resultText).toContain('<lca-mode name="plan">')
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
    const after = readWorkflow(wt.worktree)!
    expect(after.id).toBe(wf.id)
    expect(after.phase).toBe("planning")
  })

  test("foreign session with a dead owner + keyword: T20 cancels the old workflow (owner_conflict event), then a fresh workflow starts for this session", async () => {
    const old = putWorkflow(OTHER, { phase: "planning", owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    await sendText("ralplan: add a login button", S)

    const archived = JSON.parse(readFileSync(archivePath(wt.worktree, old.id), "utf8")) as Workflow
    expect(archived.phase).toBe("cancelled")

    const oldEvents = readEvents(wt.worktree, old.id)
    expect(oldEvents.some((e) => e.type === "owner_conflict" && e.actor === "code")).toBe(true)

    const wf = readWorkflow(wt.worktree)!
    expect(wf.id).not.toBe(old.id)
    expect(wf.sessionID).toBe(S)
    expect(wf.entry).toBe("keyword")
    expect(wf.phase).toBe("planning")
  })

  test("foreign session with a live owner + keyword -> refusal text, no mutation", async () => {
    mkdirSync(sessionDir(wt.worktree, OTHER), { recursive: true }) // owner liveness requires the owning session to exist
    const old = putWorkflow(OTHER, { phase: "planning" }) // currentOwner(): this process, live
    const wfBefore = readFileSync(workflowPath(wt.worktree))
    const evBefore = (() => {
      try {
        return readFileSync(eventsPath(wt.worktree))
      } catch {
        return null
      }
    })()

    const resultText = await sendText("ralplan: add a login button", S)
    expect(resultText).toContain(`plan workflow ${old.id} is already active in session ${OTHER}`)

    expect(readFileSync(workflowPath(wt.worktree))).toEqual(wfBefore)
    const evAfter = (() => {
      try {
        return readFileSync(eventsPath(wt.worktree))
      } catch {
        return null
      }
    })()
    expect(evAfter).toEqual(evBefore)
    expect(readWorkflow(wt.worktree)!.id).toBe(old.id)
  })
})
