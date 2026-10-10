import { describe, expect, test } from "bun:test"
import { AGENT_DEFS, mainPrompt, MAIN_PROMPT, REVIEWER_PROMPT, WORKER_PROMPT } from "../src/agents/prompts.ts"
import { estimateTokens } from "../src/tokens.ts"

describe("prompt budgets", () => {
  test("main <= 1500 est. tokens", () => {
    expect(estimateTokens(MAIN_PROMPT)).toBeLessThanOrEqual(1500)
  })
  test("worker <= 800 est. tokens", () => {
    expect(estimateTokens(WORKER_PROMPT)).toBeLessThanOrEqual(800)
  })
  test("reviewer <= 600 est. tokens", () => {
    expect(estimateTokens(REVIEWER_PROMPT)).toBeLessThanOrEqual(600)
  })
})

describe("prompt content", () => {
  test.each(["main", "worker", "reviewer"] as const)("%s includes minimal-code guidance without sacrificing safeguards", (name) => {
    const prompt = AGENT_DEFS[name].prompt!
    expect(prompt.split("Coding conventions:")).toHaveLength(2)
    expect(prompt).toContain("Trace the real flow and callers first; fix shared root causes.")
    expect(prompt).toContain("reuse existing code, standard library, native platform features, and installed dependencies")
    expect(prompt).toContain("simplify or delete only within task scope")
    expect(prompt).toContain("Readability over clever one-liners")
    expect(prompt).toContain("Keep trust-boundary validation, data-loss error handling, security and accessibility.")
    expect(prompt).toContain("runnable checks within role permissions; performance claims need measurements")
  })

  test("main prompt variants retain conventions and conditional rule numbering within budget", () => {
    for (const delegate of [false, true]) {
      for (const data of [false, true]) {
        for (const flow of [false, true]) {
          const prompt = mainPrompt(delegate, data, flow)
          expect(prompt.split("Coding conventions:")).toHaveLength(2)
          expect(estimateTokens(prompt)).toBeLessThanOrEqual(1500)
          expect(prompt.includes("Call the delegate tool once")).toBe(delegate)
          expect(prompt.includes("write a numbered task list first")).toBe(!delegate)
          expect(prompt.includes("Question about the project database")).toBe(data && delegate)
          expect(prompt.includes("submit plans only with lca_flow")).toBe(flow)
          const numbers = [...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
          const count = 8 + Number(data && delegate) + Number(flow)
          expect(numbers).toEqual(Array.from({ length: count }, (_, i) => i + 1))
        }
      }
    }
  })

  test("main: talk to user, delegate big tasks, no task tool, no repeats, edit over write, stop when done", () => {
    expect(MAIN_PROMPT).toMatch(/task list/i)
    // stage 2: big work goes through the plugin's delegate tool, called once with the whole list
    expect(MAIN_PROMPT).toMatch(/Call the delegate tool once/i)
    expect(MAIN_PROMPT).toMatch(/verify command/i)
    expect(MAIN_PROMPT).toMatch(/Never repeat the same call/i)
    expect(MAIN_PROMPT).toMatch(/read the error/i)
    expect(MAIN_PROMPT).toMatch(/Use edit for existing files/i)
    expect(MAIN_PROMPT).toMatch(/stop\./i)
    expect(MAIN_PROMPT).toMatch(/No closing summary/i)
    expect(MAIN_PROMPT).toMatch(/not the whole suite/i)
    expect(MAIN_PROMPT).toMatch(/given order/i)
    expect(MAIN_PROMPT).toMatch(/do not rerun its tests or fix failed tasks yourself/i)
    // the built-in task tool is off; main must never be pointed at it
    expect(MAIN_PROMPT).not.toMatch(/\btask tool\b|\bsubagent\b/i)
  })

  test("worker: one task, no scope creep, framework-owned verification, <=10 line report, no subagents", () => {
    expect(WORKER_PROMPT).toMatch(/exactly one task/i)
    expect(WORKER_PROMPT).toMatch(/No extra refactors/i)
    expect(WORKER_PROMPT).toMatch(/Do not invoke Bash or run tests or verification commands/i)
    expect(WORKER_PROMPT).toMatch(/framework runs the task's declared verify after your edits/i)
    expect(WORKER_PROMPT).toMatch(/report Verification: pending and never claim it passed/i)
    expect(WORKER_PROMPT).not.toMatch(/Run the verify command given in the task/i)
    expect(WORKER_PROMPT).toMatch(/at most 10 lines/i)
    expect(WORKER_PROMPT).toMatch(/Files changed:/)
    expect(WORKER_PROMPT).toMatch(/Verification:/)
    expect(WORKER_PROMPT).toMatch(/Verification: pending \(the framework runs the declared verify\)/)
    expect(WORKER_PROMPT).toMatch(/Open issues:/)
    expect(WORKER_PROMPT).toMatch(/Never spawn subagents/i)
    expect(WORKER_PROMPT).toMatch(/Never repeat the same call/i)
  })

  test("reviewer: read-only, ACCEPT / REJECT first line, <=5 bullets", () => {
    expect(REVIEWER_PROMPT).toMatch(/read-only/i)
    expect(REVIEWER_PROMPT).toMatch(/never edit or write/i)
    expect(REVIEWER_PROMPT).toMatch(/^ACCEPT$/m)
    expect(REVIEWER_PROMPT).toMatch(/^REJECT: <one-line reason>$/m)
    expect(REVIEWER_PROMPT).toMatch(/Last line, exactly one of/i)
    expect(REVIEWER_PROMPT).toMatch(/Answer these four lines first/i)
  })
})

describe("AGENT_DEFS", () => {
  test("main is primary with task denied", () => {
    expect(AGENT_DEFS.main.mode).toBe("primary")
    expect(AGENT_DEFS.main.prompt).toBe(MAIN_PROMPT)
    expect(AGENT_DEFS.main.denied_tools).toContain("task")
    expect(AGENT_DEFS.main.denied_tools).not.toContain("delegate")
    expect(AGENT_DEFS.main.permission).toBeDefined()
  })

  test("worker is a leaf subagent with a step cap", () => {
    expect(AGENT_DEFS.worker.mode).toBe("subagent")
    expect(AGENT_DEFS.worker.prompt).toBe(WORKER_PROMPT)
    for (const t of ["task", "delegate", "todowrite", "webfetch", "skill"]) expect(AGENT_DEFS.worker.denied_tools).toContain(t)
    expect(AGENT_DEFS.worker.steps).toBe(40)
    expect(Object.hasOwn(AGENT_DEFS.worker, "tools")).toBe(false)
    expect(Object.hasOwn(AGENT_DEFS.worker, "maxSteps")).toBe(false)
  })

  test("reviewer cannot write or run commands", () => {
    expect(AGENT_DEFS.reviewer.mode).toBe("subagent")
    expect(AGENT_DEFS.reviewer.prompt).toBe(REVIEWER_PROMPT)
    for (const t of ["write", "edit", "patch", "bash", "task", "delegate"]) expect(AGENT_DEFS.reviewer.denied_tools).toContain(t)
    expect(AGENT_DEFS.reviewer.permission?.edit).toBe("deny")
    expect(AGENT_DEFS.reviewer.permission?.bash).toBe("deny")
    expect(REVIEWER_PROMPT).toMatch(/never run commands/i)
    expect(REVIEWER_PROMPT).toMatch(/Missing tests are never a reject reason/i)
    expect(REVIEWER_PROMPT).toMatch(/Test-aware code \(call counters/i)
    expect(REVIEWER_PROMPT).toMatch(/even if the task text asked for it/i)
    expect(WORKER_PROMPT).toMatch(/Never edit a test file. Never write code that only works for the test's inputs/i)
    expect(WORKER_PROMPT).toMatch(/refuse and say why under Open issues/i)
    expect(REVIEWER_PROMPT).not.toMatch(/tests fail/i)
  })

  test("no def carries model or temperature (applied by the config hook)", () => {
    for (const def of Object.values(AGENT_DEFS)) {
      expect(Object.hasOwn(def, "model")).toBe(false)
      expect(Object.hasOwn(def, "temperature")).toBe(false)
    }
  })
})
