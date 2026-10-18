// P6a S4: `/skill:deep-interview` and `/skill:ralplan` through the real interactive session (runInteractiveSession), the
// real engines and turns, over the deterministic scripted host. Covers W2 (one owner kind, inline choosers, committed
// status, collision cannot redirect), W3 (preset, not consent) and W9 (concurrent starts) at the dispatch layer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runInteractiveSession, type InteractiveDependencies, type Terminal } from "../src/hosts/interactive-session.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readEvents } from "../src/flow/state.ts"
import { readLedger } from "../src/state/ledger.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { fullScript, scriptedRuntime } from "./workflow-fixture.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { stopHeartbeat(); wt.cleanup() })

type Options = { lines: Array<string | undefined>; choices?: number[]; script?: Record<string, string[]>; plainReadline?: boolean; ask?: (prompt: any) => unknown }

async function session(options: Options) {
  const lines = [...options.lines]
  const choices = [...(options.choices ?? [])]
  const output: string[] = []
  const statuses: Array<string | undefined> = []
  const asks: unknown[] = []
  const chooses: Array<{ title: string; values: readonly string[] }> = []
  const fixture = scriptedRuntime(wt.worktree, options.script ?? fullScript())
  const conversationTurns: string[] = []
  const terminal: Terminal = {
    stdinIsTTY: true, stderrIsTTY: true,
    readLine: async () => lines.shift(),
    ...(options.plainReadline ? {} : {
      choose: async (title: string, values: readonly string[]) => { chooses.push({ title, values }); return choices.shift() ?? 0 },
      workflowStatus: (line: string | undefined) => { statuses.push(line) },
    }),
    ...(options.ask ? { ask: async (prompt: unknown) => { asks.push(prompt); return options.ask!(prompt) } } : {}),
    write: text => { output.push(text) },
    close() {},
  } as Terminal
  let uuid = 0
  const deps: Partial<InteractiveDependencies> = {
    cwd: wt.worktree, terminal, gitTopLevel: () => wt.worktree,
    createRuntime: () => fixture.runtime,
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
  const read = readCommitted(wt.worktree)
  return read.state === "ok" ? read.wf : undefined
}

describe("deep-interview then ralplan through the interactive session", () => {
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
    const created = readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["deep-interview", "ralplan"])
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    const roles = new Set(s.seen.map(item => item.role))
    expect([...roles].every(role => ["interviewer", "researcher", "contrarian", "simplifier", "planner", "architect", "critic"].includes(role))).toBe(true)
  })

  test("/finish is wired: from round 3 above the threshold it warns, records the early exit and still runs closure and the restatement", async () => {
    const script = fullScript()
    script["di.interviewer.question"] = ["Q1", "Q2", "Q3", "Q4"].map(text => JSON.stringify({ type: "question", text }))
    // ambiguity .5 (progress), .35 (progress), .2 (refined: a band change, so one researcher/contrarian/simplifier panel)
    script["di.scorer"] = [0.5, 0.65, 0.8].map(v => JSON.stringify({ type: "score", goal: v, constraints: v, criteria: v, context: v, weakest: "goal", evidence: ["e"] }))
    const s = await session({
      lines: ["/skill:deep-interview build the widget", "a1", "a2", "a3", "/finish", "/quit"],
      // topology Confirm, then "Finish early", then restate Yes, then consensus Decide later
      choices: [0, 0, 0, 2],
      script,
    })
    expect(s.exit.code).toBe(0)
    const early = s.chooses.find(item => item.values[0] === "Finish early")
    expect(early?.title).toContain("above the 0.05 threshold")
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
      question: "Question 1: Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }, { label: "Files" }], recommended: 1, allowCustom: true,
    })
    expect(s.asks).toHaveLength(2)
    expect(roundAnswers()).toEqual(["Files", "typed fallback"])
    expect(s.output).toContain("Question 2:\nWhich UI?")
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

  test("/skill:ralplan alone starts exactly one ralplan; typed confirmation of execution refuses without ultragoal", async () => {
    const s = await session({
      lines: ["/skill:ralplan plan the widget", "wrong text", "/quit"],
      choices: [1],
    })
    expect(s.exit.code).toBe(0)
    const created = readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)
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
    const created = readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["deep-interview", "ralplan"])
  })

  test("/skill:ultragoal starts exactly one owner kind but does not execute without APPROVE-UNIT", async () => {
    const s = await session({ lines: ["/skill:ultragoal ship it", "", "/quit"] })
    expect(s.output).toContain("Unit not approved")
    expect(committed()).toMatchObject({ kind: "ultragoal", stage: "unit_approval", phase: "pending_approval" })
    const created = readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["ultragoal"])
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    expect(s.seen.map(item => item.promptId)).toEqual(["ug.decompose", "ug.unit_plan", "ug.unit_review"])
  })

  test("/skill:autoresearch starts exactly one owner kind but does not run commands without RUN", async () => {
    const s = await session({ lines: ["/skill:autoresearch find out", "", "/quit"] })
    expect(s.output).toContain("Experiment not approved")
    expect(committed()).toMatchObject({ kind: "autoresearch", stage: "experiment_approval", phase: "pending_approval" })
    const created = readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)
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
    const created = readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)
    expect(created).toEqual(["deep-interview", "ralplan"])
    expect(s.chooses.some(item => item.title.includes("not consent to execute"))).toBe(true)
    expect(readLedger(wt.worktree, "otter-fixture0").tasks).toHaveLength(0)
    expect(committed()).toMatchObject({ kind: "ralplan", phase: "pending_approval" })
  })

  test("picking Start ralplan from an architecture offer starts exactly one ralplan", async () => {
    const s = await session({ lines: ["Refactor the auth module", "/quit"], choices: [1, 1] })
    expect(s.chooses[0]!.values).toEqual(["Continue in chat", "Start ralplan", "Start deep-interview first", "Cancel"])
    expect(s.conversationTurns).toEqual([])
    const created = readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)
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
