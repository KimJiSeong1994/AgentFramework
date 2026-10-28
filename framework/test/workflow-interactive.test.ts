// P6a S4: `/skill:deep-interview` and `/skill:ralplan` through the real interactive session (runInteractiveSession), the
// real engines and turns, over the deterministic scripted host. Covers W2 (one owner kind, inline choosers, committed
// status, collision cannot redirect), W3 (preset, not consent) and W9 (concurrent starts) at the dispatch layer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { runInteractiveSession, type InteractiveDependencies, type Terminal } from "../src/hosts/interactive-session.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readEvents } from "../src/flow/state.ts"
import { readLedger } from "../src/state/ledger.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import { getOwnedSession, readSessionMetadata, replaySession } from "../src/sessions/store.ts"
import { activeAnyWorkflow } from "../src/flow/state.ts"
import { resumeAdmission } from "../src/sessions/admission.ts"
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { fullScript, scriptedHost, scriptedRuntime, stage } from "./workflow-fixture.ts"
import { executeConfirmation } from "../src/workflows/ralplan-driver.ts"
import { ralplanDataOf } from "../src/workflows/ralplan.ts"
import { approveUnitConfirmation, ultragoalDataOf } from "../src/workflows/ultragoal.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { stopHeartbeat(); wt.cleanup() })

type Options = { isolate?: boolean; lines: Array<string | undefined | (() => string)>; choices?: number[]; script?: Record<string, string[]>; plainReadline?: boolean; ask?: (prompt: any) => unknown; controls?: Record<string, "interrupt" | "cancel">; uuidBase?: number; worker?: (request: ExecutionRequest) => ExecutionOutcome }

async function session(options: Options) {
  const lines = [...options.lines]
  const choices = [...(options.choices ?? [])]
  const output: string[] = []
  const statuses: Array<string | undefined> = []
  const asks: unknown[] = []
  const chooses: Array<{ title: string; values: readonly string[] }> = []
  const fixture = scriptedRuntime(wt.worktree, options.script ?? fullScript())
  if (options.worker) {
    fixture.runtime.config.chat.worktree = options.isolate ? "plan" : "off"
    const prepare = fixture.host.prepare.bind(fixture.host)
    fixture.host.prepare = async request => {
      const handle = await prepare(request)
      if (request.role === "worker" || request.role === "reviewer") {
        let done = false
        return {
          ...handle,
          run: async () => {
            const result = request.role === "worker" ? options.worker!(request) : { status: "completed" as const, text: "ACCEPT" }
            done = true
            return result
          },
          reconcile: async () => ({ outcome: done ? "terminal" as const : "unknown" as const, quiescent: done, evidence: "fixture worker completed" }),
        }
      }
      return handle
    }
  }
  const conversationTurns: string[] = []
  let control: ((action: "interrupt" | "cancel") => void) | undefined
  const terminal: Terminal = {
    stdinIsTTY: true, stderrIsTTY: true,
    // A `controls` key is a sentinel line: it delivers that key control (Escape = interrupt) and then reads on.
    readLine: async () => {
      let line = lines.shift()
      while (line !== undefined && typeof line === "string" && options.controls?.[line]) { control?.(options.controls[line]!); line = lines.shift() }
      return typeof line === "function" ? line() : line
    },
    controls: (handler: (action: any) => void) => { control = handler },
    ...(options.plainReadline ? {} : {
      choose: async (title: string, values: readonly string[]) => { chooses.push({ title, values }); return choices.shift() ?? 0 },
      workflowStatus: (line: string | undefined) => { statuses.push(line) },
    }),
    ...(options.ask ? { ask: async (prompt: unknown) => { asks.push(prompt); return options.ask!(prompt) } } : {}),
    write: text => { output.push(text) },
    close() {},
  } as Terminal
  let uuid = options.uuidBase ?? 0
  const deps: Partial<InteractiveDependencies> = {
    cwd: wt.worktree, terminal, gitTopLevel: () => wt.worktree,
    createRuntime: options => {
      fixture.runtime.log = (message, fields) => options.progress?.queue(message, fields)
      return fixture.runtime
    },
    admitRuntime: async () => {},
    createConversation: () => ({ turn: async text => { conversationTurns.push(text); return { text: "Acknowledged." } } }),
    discoverModels: async () => { throw new Error("no model discovery") },
    randomUUID: () => `fixture${uuid++}`,
  }
  const exit = await runInteractiveSession({ worktree: wt.worktree, engine: "local", model: "fixture-model" }, deps)
  return { exit, output: output.join(""), statuses, chooses, asks, conversationTurns, ...fixture, remaining: lines }
}

const answers = ["first answer", "second answer"]
const committed = () => {
  const read = readCommitted(wt.worktree, {}, "otter-fixture0")
  return read.state === "ok" ? read.wf : undefined
}

describe("deep-interview then ralplan through the interactive session", () => {
  test("a timing transcript write failure aborts and holds the session before another request", async () => {
    let failed = false
    let nextRequest = false
    await expect(session({ lines: [() => {
      const store = getOwnedSession(wt.worktree, "otter-fixture0")!
      const append = store.append.bind(store)
      store.append = (kind, data, eventID) => {
        if (kind === "timing") { failed = true; throw new Error("PRIVATE_TIMING_STORAGE_FAILURE") }
        return append(kind, data, eventID)
      }
      return "/skill:ralplan plan a change"
    }, () => { nextRequest = true; return "/quit" }] })).rejects.toThrow("Session transcript persistence failed; the session remains held.")
    expect(failed).toBe(true)
    expect(nextRequest).toBe(false)
    expect(readSessionMetadata(wt.worktree, "otter-fixture0")?.held).toBe(true)
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
  })

  test("one owner kind per start; inline choosers; committed status; auto-connect; consensus does not execute", async () => {
    const s = await session({
      lines: ["/skill:deep-interview build the widget", ...answers, "/quit"],
      // topology Confirm, restate Yes, then the consensus choice: Decide later
      choices: [0, 0, 2],
    })
    expect(s.exit.code).toBe(0)
    expect(s.remaining).toEqual([])
    const wf = committed()!
    expect(wf).toMatchObject({ kind: "ralplan", stage: "pending_execution", phase: "pending_approval" })
    expect(wf.lineage?.predecessor.kind).toBe("deep-interview")
    // choosers are inline lists, with the workflow's own questions
    expect(s.chooses.map(item => item.values)).toEqual([
      ["Confirm topology", "Adjust topology"],
      ["Yes, crystallize", "Adjust wording", "Missing scope"],
      ["Stop here (planning complete; not executed)", "Execute via ultragoal (needs a typed confirmation)", "Decide later"],
    ])
    expect(s.chooses[0]!.title).toContain("Confirm the topology")
    expect(s.chooses[2]!.title).toContain("not consent to execute")
    // status segment shows committed kind · stage (the first segment is deep-interview · topology)
    const shown = s.statuses.filter((line): line is string => line !== undefined)
    expect(shown[0]).toBe("deep-interview · topology · planning")
    expect(shown.some(line => line.startsWith("deep-interview · answer"))).toBe(true)
    expect(shown.some(line => line.startsWith("ralplan · planner"))).toBe(true)
    expect(shown.at(-1)).toContain("ralplan · pending_execution · pending_approval")
    expect(s.output).toContain("Connected to ralplan")
    expect(s.output).toContain("Architect CLEAR/APPROVE + Critic OKAY · execution pending")
    // exactly one DI and one ralplan were created; nothing executed
    const created = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["deep-interview", "ralplan"])
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    const timings = replaySession(wt.worktree, "otter-fixture0", { kind: "timing" }).records
    expect(timings.filter(record => record.data.kind === "ralplan").map(record => record.data.stage)).toEqual(["planner", "architect", "critic"])
    expect(timings.every(record => record.data.category === "workflow" && Number.isSafeInteger(record.data.durationMs))).toBe(true)
    expect(timings.every(record => !("text" in record.data) && !("prompt" in record.data))).toBe(true)
    const roles = new Set(s.seen.map(item => item.role))
    expect([...roles].every(role => ["interviewer", "researcher", "contrarian", "simplifier", "planner", "architect", "critic"].includes(role))).toBe(true)
  })

  test("an idle Escape keeps the interview; only an explicit /cancel stops it", async () => {
    const kept = await session({ lines: ["/skill:deep-interview build the widget", "<esc>", "/quit"], choices: [0], controls: { "<esc>": "interrupt" } })
    expect(kept.exit.code).toBe(0)
    expect(activeAnyWorkflow(wt.worktree, "otter-fixture0")).toMatchObject({ kind: "deep-interview", phase: "planning" })
    expect(readEvents(wt.worktree, undefined, "otter-fixture0").some(event => event.type === "cancelled")).toBe(false)

    const stopped = await session({ lines: ["/cancel", "/quit"], choices: [] })
    expect(stopped.exit.code).toBe(0)
    expect(readEvents(wt.worktree, undefined, "otter-fixture0").some(event => event.type === "cancelled")).toBe(true)
  })

  test("another session can chat and switch models without touching the original workflow", async () => {
    await session({ lines: ["/skill:deep-interview build the widget", "/quit"], choices: [0] })
    const owner = activeAnyWorkflow(wt.worktree, "otter-fixture0")!
    const observer = await session({ lines: ["hello", "/model local model-b", "/quit"], uuidBase: 100 })
    expect(observer.exit.code).toBe(0)
    expect(observer.output).not.toContain("Read-only observer")
    expect(observer.output).not.toContain("Model selection is unavailable")
    expect(observer.output).not.toContain("Model switch refused")
    expect(observer.output).toContain("── local · model-b")
    expect(observer.conversationTurns).toEqual(["hello"])
    expect(activeAnyWorkflow(wt.worktree, "otter-fixture0")).toMatchObject({ id: owner.id, sessionID: owner.sessionID, phase: "planning" })
  })

  test("/finish is wired: after one scored round above the threshold it warns, records the early exit and still runs closure and the restatement", async () => {
    const script = fullScript()
    script["di.interviewer.question"] = ["Q1", "Q2"].map(text => JSON.stringify({ type: "question", text }))
    // One scored answer leaves ambiguity .5 above the agenda threshold.
    script["di.scorer"] = [0.5].map(v => JSON.stringify({ type: "score", goal: v, constraints: v, criteria: v, context: v, weakest: "goal", evidence: ["e"] }))
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "a1", "/finish", "/quit"],
      // topology Confirm, then "Finish early", then restate Yes, then consensus Decide later
      choices: [0, 0, 0, 2],
      script,
    })
    expect(s.exit.code).toBe(0)
    const early = s.chooses.find(item => item.values[0] === "Finish early")
    expect(early?.title).toContain("above the 0.2 threshold")
    expect(s.chooses.some(item => item.values[0] === "Yes, crystallize")).toBe(true)
    expect(s.seen.some(item => item.promptId === "di.closure")).toBe(true)
    const wf = committed()!
    expect(wf.kind).toBe("ralplan")
  })

  test("readline fallback prints a numbered list and the Workflow line, and takes a number", async () => {
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "1", ...answers, "1", "3", "/quit"],
      plainReadline: true,
    })
    expect(s.exit.code).toBe(0)
    expect(s.output).toContain("  1) Confirm topology")
    expect(s.output).toContain("Workflow: deep-interview · topology · planning")
    expect(s.output).toContain("Workflow: ralplan · planner")
    expect(committed()).toMatchObject({ kind: "ralplan", stage: "pending_execution" })
  })

  function optionScript() {
    const script = fullScript()
    script["di.interviewer.question"] = [
      JSON.stringify({ type: "question", text: "Which store?", options: ["SQLite", "Postgres", "Files"], recommended: 1 }),
      JSON.stringify({ type: "question", text: "Which UI?", options: ["CLI", "Web"] }),
    ]
    return script
  }
  const roundAnswers = () => {
    const root = join(wt.worktree, ".otter", "workflows")
    const out: string[] = []
    for (const sid of readdirSync(root)) for (const wid of readdirSync(join(root, sid))) {
      for (const n of [1, 2]) {
        try { out.push(readFileSync(join(root, sid, wid, "rounds", `${n}-answer.md`), "utf8")) } catch { /* absent */ }
      }
    }
    return out
  }

  test("readline: options are printed numbered; a bare number picks the option, anything else is the answer", async () => {
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "1", "2", "my own words", "1", "3", "/quit"],
      plainReadline: true, script: optionScript(),
    })
    expect(s.output).toContain("  1) SQLite\n  2) Postgres (Recommended)\n  3) Files\nType a number or your own answer; /finish ends early.")
    expect(roundAnswers()).toEqual(["Postgres", "my own words"])
  })

  test("terminal.ask: option and custom answers are recorded; dismissal falls back to the chat prompt", async () => {
    const replies = [{ kind: "option", index: 2 }, undefined]
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "typed fallback", "/quit"],
      script: optionScript(), choices: [0, 0, 2],
      ask: () => replies.shift(),
    })
    expect(s.asks[0]).toEqual({
      question: "Task 1/1 · core: the core engine · question 1/2: Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }, { label: "Files" }], recommended: 1, allowCustom: true,
    })
    expect(s.asks).toHaveLength(2)
    expect(roundAnswers()).toEqual(["Files", "typed fallback"])
    expect(s.output).toContain("Task 1/1 · core: the core engine · question 2/2:\nWhich UI?")
  })

  test("terminal.ask: a /command typed into the Other editor runs as a command and is never recorded as an answer", async () => {
    // /status in the editor writes status and falls back to the chat prompt; /model there rebinds in place, and the
    // next plain line answers round 1 on the new model. A slash text that is no command is the answer as typed.
    const replies = [{ kind: "custom", text: "/status" }, { kind: "custom", text: "/usr/bin is fine" }]
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "/model local other-model", "after switch", "/quit"],
      script: optionScript(), choices: [0, 0, 2],
      ask: () => replies.shift(),
    })
    expect(s.output).toContain("Same session and workflow")
    expect(roundAnswers()).toEqual(["after switch", "/usr/bin is fine"])
    expect(roundAnswers()).not.toContain("/status")
  })

  test("terminal.ask: /finish typed into the Other editor ends the interview early instead of being an answer", async () => {
    const script = optionScript()
    script["di.interviewer.question"] = ["Q1", "Q2"].map(text => JSON.stringify({ type: "question", text, options: ["x", "y"] }))
    script["di.scorer"] = [0.5].map(v => JSON.stringify({ type: "score", goal: v, constraints: v, criteria: v, context: v, weakest: "goal", evidence: ["e"] }))
    const replies = [{ kind: "option", index: 0 }, { kind: "custom", text: "/finish" }]
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "/quit"],
      script, choices: [0, 0, 0, 2], ask: () => replies.shift(),
    })
    expect(s.chooses.some(item => item.values[0] === "Finish early")).toBe(true)
    expect(roundAnswers()).toEqual(["x"])
    expect(roundAnswers()).not.toContain("/finish")
  })

  test("terminal.ask: a custom answer is used as typed", async () => {
    const replies = [{ kind: "custom", text: "  bespoke  " }, { kind: "option", index: 0 }]
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "/quit"],
      script: optionScript(), choices: [0, 0, 2], ask: () => replies.shift(),
    })
    expect(roundAnswers()).toEqual(["bespoke", "CLI"])
    expect(s.exit.code).toBe(0)
  })

  test.each(["", "wrong approval"])("confirmed planning automatically reaches unit approval without /continue; unit input %j stays pending", async unitInput => {
    const s = await session({
      lines: ["/skill:deep-interview build the widget", ...answers, () => {
        const wf = committed()!
        if (wf.kind !== "ralplan") throw new Error("expected pending ralplan")
        return executeConfirmation(wf.id, ralplanDataOf(wf).consensus!.planSha)
      }, unitInput, "/quit"],
      choices: [0, 0, 1],
    })
    expect(s.exit.code).toBe(0)
    expect(s.seen.filter(item => item.promptId.startsWith("ug.")).map(item => item.promptId))
      .toEqual(["ug.decompose", "ug.unit_plan", "ug.unit_review"])
    expect(committed()).toMatchObject({ kind: "ultragoal", stage: "unit_approval", phase: "pending_approval" })
    expect(s.output).toContain(unitInput ? "Unit approval refused" : "Unit not approved")
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    expect(readFileSync(join(wt.worktree, "README.md"), "utf8")).toBe("fixture\n")
  })

  test.each([false, true])("confirmed planning and typed unit approval execute a file change through the queue and verifier; explicit ultragoal %j", async explicitStart => {
    writeFileSync(join(wt.worktree, "check.sh"), "test \"$(cat README.md)\" = implemented\n")
    let workers = 0
    const s = await session({
      lines: ["/skill:deep-interview build the widget", ...answers, ...(explicitStart ? ["/skill:ultragoal"] : []), () => {
        const wf = committed()!
        if (wf.kind !== "ralplan") throw new Error("expected pending ralplan")
        return executeConfirmation(wf.id, ralplanDataOf(wf).consensus!.planSha)
      }, () => {
        const wf = committed()!
        if (wf.kind !== "ultragoal") throw new Error("expected pending ultragoal")
        expect(workers).toBe(0)
        expect(readFileSync(join(wt.worktree, "README.md"), "utf8")).toBe("fixture\n")
        return approveUnitConfirmation(wf.id, ultragoalDataOf(wf).pending!.subject.sha256)
      }, "/quit"],
      choices: explicitStart ? [0, 0, 2, 1, 1] : [0, 0, 1, 1],
      worker: request => {
        expect(request.text).toContain("README.md")
        workers++
        writeFileSync(join(wt.worktree, "README.md"), "implemented\n")
        return { status: "completed", text: "Open issues: none" }
      },
    })
    expect(s.exit.code).toBe(0)
    expect(s.chooses.filter(item => item.title.includes("stuck"))).toEqual([])
    expect(workers).toBe(1)
    expect(readFileSync(join(wt.worktree, "README.md"), "utf8")).toBe("implemented\n")
    expect(s.output).toContain("Ultragoal complete")
    expect(committed()).toMatchObject({ kind: "ultragoal", phase: "done" })
    const tasks = readLedger(wt.worktree, "otter-fixture0").tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ status: "done", verify_result: { command: "sh check.sh", ok: true, exitCode: 0 } })
  })

  test.each([0, 1])("approved unit offers explicit in-place recovery without a first commit; choice %j", async choice => {
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/unborn-recovery"], { cwd: wt.worktree })
    writeFileSync(join(wt.worktree, "check.sh"), "test -f implemented.txt\n")
    let workers = 0
    const approval = () => {
      const wf = committed()!
      if (wf.kind !== "ultragoal") throw new Error("expected ultragoal")
      return approveUnitConfirmation(wf.id, ultragoalDataOf(wf).pending!.subject.sha256)
    }
    const script = fullScript()
    script["ug.decompose"] = [JSON.stringify({ type: "goals", goals: [{ title: "One", objective: "First change" }, { title: "Two", objective: "Second change" }] })]
    script["ug.unit_plan"] = [stage.unitPlan, stage.unitPlan]
    script["ug.unit_review"] = [stage.critic, stage.critic]
    const s = await session({
      script,
      isolate: true,
      lines: ["/skill:ultragoal build the widget", approval, ...(choice === 0 ? [approval] : []), "/quit"],
      choices: [choice, 0],
      worker: request => {
        workers++
        expect(request.cwd).toBe(wt.worktree)
        writeFileSync(join(request.cwd, "implemented.txt"), "done\n")
        return { status: "completed", text: "Open issues: none" }
      },
    })
    expect(s.chooses.filter(item => item.title.includes("Plan worktree unavailable"))).toHaveLength(choice === 0 ? 2 : 1)
    expect(workers).toBe(choice === 0 ? 2 : 0)
    expect(committed()?.phase).toBe(choice === 0 ? "done" : "cancelled")
  })

  test("starting ultragoal with a new request preserves the pending plan", async () => {
    const s = await session({
      lines: ["/skill:ralplan original objective", "/skill:ultragoal different objective", "/quit"], choices: [2],
    })
    expect(s.output).toContain("new request has not replaced its objective")
    const wf = committed()!
    expect(wf).toMatchObject({ kind: "ralplan", stage: "pending_execution" })
    if (wf.kind !== "ralplan") throw new Error("expected ralplan")
    expect(ralplanDataOf(wf).request).toBe("original objective")
    expect(s.seen.some(item => item.promptId.startsWith("ug."))).toBe(false)
  })

  test("bare ultragoal cannot take another session's pending plan", async () => {
    await session({ lines: ["/skill:ralplan original objective", "/quit"], choices: [2] })
    const owner = committed()!
    const s = await session({ lines: ["/skill:ultragoal", "/quit"], uuidBase: 100 })
    expect(s.output).not.toContain("workflow belongs to")
    expect(readCommitted(wt.worktree, {}, "otter-fixture100").state).toBe("none")
    expect(committed()).toMatchObject({ id: owner.id, sessionID: owner.sessionID, kind: "ralplan" })
    expect(s.seen).toHaveLength(0)
  })

  test("bare ultragoal continues its pending unit without starting another workflow", async () => {
    const s = await session({ lines: ["/skill:ultragoal ship it", "", "/skill:ultragoal", "wrong approval", "/quit"] })
    expect(s.output).toContain("Unit approval refused")
    expect(committed()).toMatchObject({ kind: "ultragoal", stage: "unit_approval", phase: "pending_approval" })
    expect(readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created")).toHaveLength(1)
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
  })

  test("bare ultragoal cannot bypass an unfinished interview", async () => {
    const s = await session({ lines: ["/skill:deep-interview build it", "/skill:ultragoal", "/quit"], choices: [0] })
    expect(committed()).toMatchObject({ kind: "deep-interview", stage: "answer" })
    expect(readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created")).toHaveLength(1)
    expect(s.seen.some(item => item.promptId.startsWith("ug."))).toBe(false)
  })

  test("bare ultragoal cannot bypass a paused plan", async () => {
    const s = await session({
      lines: ["/skill:ralplan original objective", "/pause", "/skill:ultragoal", "/quit"], choices: [2],
    })
    expect(s.output).toContain("Session held: use /continue")
    expect(committed()).toMatchObject({ kind: "ralplan", phase: "paused" })
    expect(s.seen.some(item => item.promptId.startsWith("ug."))).toBe(false)
  })

  test.each([
    { choice: 0, confirmation: undefined, phase: "done" },
    { choice: 2, confirmation: undefined, phase: "pending_approval" },
    { choice: 1, confirmation: "", phase: "pending_approval" },
    { choice: 1, confirmation: "wrong text", phase: "pending_approval" },
  ])("planning choice $choice with confirmation '$confirmation' cannot start execution", async ({ choice, confirmation, phase }) => {
    const s = await session({
      lines: ["/skill:ralplan plan the widget", ...(confirmation === undefined ? [] : [confirmation]), "/quit"],
      choices: [choice],
    })
    expect(s.exit.code).toBe(0)
    expect(committed()).toMatchObject({ kind: "ralplan", phase })
    expect(s.seen.some(item => item.promptId.startsWith("ug."))).toBe(false)
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
  })

  test("/skill:ralplan alone starts exactly one ralplan; typed confirmation of execution refuses without ultragoal", async () => {
    const s = await session({
      lines: ["/skill:ralplan plan the widget", "wrong text", "/quit"],
      choices: [1],
    })
    expect(s.exit.code).toBe(0)
    const created = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["ralplan"])
    expect(s.output).toContain("Execution not started")
    expect(committed()).toMatchObject({ kind: "ralplan", stage: "pending_execution", phase: "pending_approval" })
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
  })
})

describe("names, collisions and consent", () => {
  test("a project skill named deep-interview cannot redirect or supply instructions", async () => {
    const directory = join(wt.worktree, ".agents", "skills", "deep-interview")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: deep-interview\ndescription: shadow\nallowed-tools: [write]\n---\nSENTINEL-PROJECT-SKILL-BYTES\n")
    const s = await session({ lines: ["/skill:deep-interview build the widget", "a1", "a2", "/quit"], choices: [0, 0, 2] })
    expect(s.exit.code).toBe(0)
    expect(s.seen.length).toBeGreaterThan(0)
    expect(s.seen.every(item => !item.text.includes("SENTINEL-PROJECT-SKILL-BYTES"))).toBe(true)
    const created = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["deep-interview", "ralplan"])
  })

  test("/skill:ultragoal starts exactly one owner kind but does not execute without APPROVE-UNIT", async () => {
    const s = await session({ lines: ["/skill:ultragoal ship it", "", "/quit"] })
    expect(s.output).toContain("Unit not approved")
    expect(committed()).toMatchObject({ kind: "ultragoal", stage: "unit_approval", phase: "pending_approval" })
    const created = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["ultragoal"])
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    expect(s.seen.map(item => item.promptId)).toEqual(["ug.decompose", "ug.unit_plan", "ug.unit_review"])
  })

  test("/skill:autoresearch starts exactly one owner kind but does not run commands without RUN", async () => {
    const s = await session({ lines: ["/skill:autoresearch find out", "", "/quit"] })
    expect(s.output).toContain("Experiment not approved")
    expect(committed()).toMatchObject({ kind: "autoresearch", stage: "experiment_approval", phase: "pending_approval" })
    const created = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["autoresearch"])
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    expect(s.seen.map(item => item.promptId)).toEqual(["ar.intake", "ar.hypothesis", "ar.evidence", "ar.experiment"])
  })

  test("a name without a request starts nothing; model-looking text starts nothing", async () => {
    const s = await session({ lines: ["/skill:deep-interview", "please run /skill:ralplan now", "/quit"] })
    expect(s.output).toContain("Usage: /skill:deep-interview <request>")
    expect(s.conversationTurns).toEqual(["please run /skill:ralplan now"])
    expect(committed()).toBeUndefined()
    expect(s.seen).toHaveLength(0)
  })

  test("a second start while a workflow is live is refused and the index is unchanged", async () => {
    // stop the first interview at its first answer prompt (readLine returns undefined = surface closed), then try a second start
    const s = await session({ lines: ["/skill:deep-interview build the widget", undefined], choices: [0] })
    expect(s.exit.code).toBe(0)
    const first = committed()!
    expect(first).toMatchObject({ kind: "deep-interview", stage: "answer" })
    const again = await session({ lines: ["/skill:ralplan another", "/quit"] })
    expect(again.output).toContain("was not started")
    expect(committed()!.id).toBe(first.id)
  })
})

describe("process safety", () => {
  test("no artifact path or project file reaches a prompt except through the engines (no .gjc state is created)", async () => {
    await session({ lines: ["/skill:deep-interview build the widget", ...answers, "/quit"], choices: [0, 0, 2] })
    expect(readdirSync(wt.worktree)).not.toContain(".gjc")
    expect(readFileSync(join(wt.worktree, "README.md"), "utf8")).toBe("fixture\n")
    expect(DEFAULT_CONFIG).toBeDefined()
  })
})

describe("intent offers start the same protected workflows", () => {
  test("picking Start deep-interview from an ambiguous offer starts exactly one deep-interview; the offer is not consent", async () => {
    const s = await session({ lines: ["make it better", ...answers, "/quit"], choices: [1, 0, 0, 2] })
    expect(s.exit.code).toBe(0)
    expect(s.chooses[0]!.values).toEqual(["Continue in chat", "Start deep-interview", "Cancel"])
    expect(s.conversationTurns).toEqual([])
    const created = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["deep-interview", "ralplan"])
    expect(s.chooses.some(item => item.title.includes("not consent to execute"))).toBe(true)
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    expect(committed()).toMatchObject({ kind: "ralplan", phase: "pending_approval" })
  })

  test("picking Start ralplan from an architecture offer starts exactly one ralplan", async () => {
    const s = await session({ lines: ["Refactor the auth module", "/quit"], choices: [1, 1] })
    expect(s.chooses[0]!.values).toEqual(["Continue in chat", "Start ralplan", "Start deep-interview first", "Cancel"])
    expect(s.conversationTurns).toEqual([])
    const created = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["ralplan"])
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
  })

  test("a live workflow held by another session shows no offer", async () => {
    const first = await session({ lines: ["/skill:deep-interview build the widget", undefined], choices: [0] })
    expect(first.exit.code).toBe(0)
    const again = await session({ lines: ["make it better", "/quit"], choices: [1] })
    expect(again.chooses).toEqual([])
    expect(again.conversationTurns).toEqual([])
    expect(committed()).toMatchObject({ kind: "deep-interview" })
  })
})

describe("model change during a workflow (same session, same workflow)", () => {
  /** Each createRuntime call builds a scripted runtime whose policy is bound to that selection's model; the script state carries over. */
  async function rebinding(lines: Array<string | undefined>, choices: number[] = [], uuidStart = 0, unsettledOnModel = false) {
    const engineFor = (engine: string) => engine
    const queue = [...lines]
    const choiceQueue = [...choices]
    const output: string[] = []
    const fixtures: Array<{ engine: string; model: string; runtime: ExecutionRuntime; seen: ReturnType<typeof scriptedHost>["seen"]; queues: Record<string, string[]> }> = []
    const turns: string[] = []
    const terminal = {
      stdinIsTTY: true, stderrIsTTY: true,
      readLine: async () => {
        const line = queue.shift()
        if (unsettledOnModel && line?.startsWith("/model")) {
          const runtime = fixtures[0]!.runtime
          const real = runtime.runs.status.bind(runtime.runs)
          runtime.runs.status = () => ({ ...real(), executions: [{ executionId: "stuck", ownerSession: "another-session", generation: 1, kind: "host", role: "interviewer" }] }) as never
        }
        return line
      },
      choose: async () => choiceQueue.shift() ?? 0,
      workflowStatus() {},
      write: (text: string) => { output.push(text) },
      close() {},
    } as unknown as Terminal
    let uuid = uuidStart
    const deps: Partial<InteractiveDependencies> = {
      cwd: wt.worktree, terminal, gitTopLevel: () => wt.worktree,
      createRuntime: options => {
        const script = fixtures.at(-1)?.queues ?? fullScript()
        const scripted = scriptedHost(script, engineFor(options.engine))
        const config = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG
        config.models = { ...config.models, main: `${options.engine}/${options.model}`, worker: `${options.engine}/${options.model}` }
        const runtime = createExecutionRuntime({ directory: wt.worktree, worktree: wt.worktree, config, log() {} }, () => scripted.host, { planningOnlyMain: true })
        fixtures.push({ engine: options.engine, model: options.model, runtime, seen: scripted.seen, queues: scripted.queues })
        return runtime
      },
      admitRuntime: async () => {},
      createConversation: () => ({ turn: async text => { turns.push(text); return { text: "Acknowledged." } } }),
      discoverModels: async () => { throw new Error("no model discovery") },
      randomUUID: () => `fixture${uuid++}`,
    }
    const exit = await runInteractiveSession({ worktree: wt.worktree, engine: "local", model: "model-a" }, deps)
    return { exit, output: output.join(""), fixtures, remaining: queue, turns }
  }

  test("deep-interview awaiting an answer: /model rebinds in place and the next step runs on the new model", async () => {
    const s = await rebinding(["/skill:deep-interview build the widget", "/model local model-b", "first answer", "second answer", "/quit"], [0, 0, 2])
    expect(s.exit.code).toBe(0)
    expect(s.remaining).toEqual([])
    expect(s.output).toContain("Now using local / model-b. Same session and workflow")
    expect(s.output).not.toContain("unavailable while an interview awaits")
    expect(s.fixtures.map(item => item.model)).toEqual(["model-a", "model-b"])
    // same session ID throughout; metadata carries the new model; only the first session was ever created
    expect(readSessionMetadata(wt.worktree, "otter-fixture0")).toMatchObject({ engine: "local", model: "model-b" })
    expect(readSessionMetadata(wt.worktree, "otter-fixture1")).toBeNull()
    const wf = readEvents(wt.worktree, undefined, "otter-fixture0").filter(event => event.type === "created")
    expect(wf.map(event => event.data?.kind)).toEqual(["deep-interview", "ralplan"])
    // steps before the switch ran on model-a, the steps after it on model-b (distinct policy IDs)
    expect(s.fixtures[0]!.seen.length).toBeGreaterThan(0)
    expect(s.fixtures[1]!.seen.length).toBeGreaterThan(0)
    const policyOf = (fixture: typeof s.fixtures[number]) => fixture.runtime.policy.resolve("interviewer").id
    expect(policyOf(s.fixtures[0]!)).not.toBe(policyOf(s.fixtures[1]!))
    const records = replaySession(wt.worktree, "otter-fixture0", { order: "asc" }).records
    const rebind = records.find(record => record.kind === "model-rebind")
    expect(rebind?.data).toMatchObject({ from: { engine: "local", model: "model-a" }, to: { engine: "local", model: "model-b" }, workflowID: expect.any(String) })
    expect(records.some(record => record.kind === "carried-context")).toBe(false)
    expect(committed()).toMatchObject({ kind: "ralplan", sessionID: "otter-fixture0" })
  })

  test("a later /resume of the same session attaches on the rebound model without a policy mismatch for settled history", async () => {
    await rebinding(["/skill:deep-interview build the widget", "/model local model-b", "/quit"], [0])
    expect(readSessionMetadata(wt.worktree, "otter-fixture0")).toMatchObject({ model: "model-b" })
    const resumed = await rebinding(["/resume otter-fixture0", "/quit"], [], 10)
    expect(resumed.output).toContain("Restored session held")
    expect(resumed.output).not.toContain("policy identity")
    expect(resumed.output).not.toContain("Session switch failed")
    expect(resumed.fixtures.some(item => item.model === "model-b")).toBe(true)
  })

  test("an engine change during a workflow is refused with the workflow named", async () => {
    const s = await rebinding(["/skill:deep-interview build the widget", "/model codex gpt-5-codex", "/quit"], [0])
    const wf = activeAnyWorkflow(wt.worktree, "otter-fixture0")!
    expect(s.output).toContain(`Model switch refused: the active workflow ${wf.id} runs on local; pick another local model, or finish/cancel the workflow to switch engines.`)
    expect(s.fixtures).toHaveLength(1)
    expect(readSessionMetadata(wt.worktree, "otter-fixture0")).toMatchObject({ engine: "local", model: "model-a" })
    expect(replaySession(wt.worktree, "otter-fixture0", { order: "asc" }).records.some(record => record.kind === "model-rebind")).toBe(false)
  })

  test("ralplan pending approval keeps its workflow across /model", async () => {
    const s = await rebinding(["/skill:deep-interview build the widget", "first answer", "second answer", "/model local model-b", "/quit"], [0, 0, 2])
    expect(s.output).toContain("Now using local / model-b. Same session and workflow")
    expect(committed()).toMatchObject({ kind: "ralplan", phase: "pending_approval", sessionID: "otter-fixture0" })
    expect(readSessionMetadata(wt.worktree, "otter-fixture0")).toMatchObject({ model: "model-b" })
    expect(s.fixtures.map(item => item.model)).toEqual(["model-a", "model-b"])
  })

  test("a rebind is refused while an execution is unsettled and nothing changes", async () => {
    const s = await rebinding(["/skill:deep-interview build the widget", "/model local model-b", "/quit"], [0], 0, true)
    expect(s.output).toContain("Model switch refused: execution ownership is unresolved")
    expect(s.output).not.toContain("Same session and workflow")
    expect(s.fixtures).toHaveLength(1)
    expect(readSessionMetadata(wt.worktree, "otter-fixture0")).toMatchObject({ model: "model-a" })
    expect(replaySession(wt.worktree, "otter-fixture0", { order: "asc" }).records.some(record => record.kind === "model-rebind")).toBe(false)
  })

  test("plain chat switch still starts a new session and carries context", async () => {
    const s = await rebinding(["hello", "/model local model-b", "/quit"])
    expect(s.output).not.toContain("Same session and workflow")
    expect(readSessionMetadata(wt.worktree, "otter-fixture1")).toMatchObject({ model: "model-b" })
    expect(replaySession(wt.worktree, "otter-fixture1", { order: "asc" }).records.some(record => record.kind === "carried-context")).toBe(true)
  })
})
