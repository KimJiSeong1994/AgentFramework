import { describe, expect, test } from "bun:test"
import {
  agendaProgress, dataOf, finalAmbiguity, newData, nextAgenda, questionBudgetReached, questionLimit,
  type DeepInterviewData,
} from "../src/workflows/deep-interview.ts"

function interview(count = 2): DeepInterviewData {
  return { ...newData("Define the components"), type: "brownfield", topology: { confirmed: true,
    components: Array.from({ length: count }, (_, i) => ({ id: `agenda-${i}`, description: `Component ${i}` })),
  } }
}
function record(d: DeepInterviewData, agendaID: string, ambiguity: number) {
  d.round += 1
  d.rounds.push({ n: d.round, agendaID, questionSha: `question-${d.round}`, answerSha: `answer-${d.round}`,
    ambiguity, scores: { goal: 1 - ambiguity, constraints: 1 - ambiguity, criteria: 1 - ambiguity, context: 1 - ambiguity },
    evidence: [`Evidence for ${agendaID}`], questionKey: `question ${d.round}` })
}

describe("bounded agenda interview state", () => {
  test("new interviews use the agenda policy while persisted legacy interviews keep their limits", () => {
    const fresh = interview()
    expect(fresh).toMatchObject({ threshold: 0.2, thresholdSource: "otter-agenda-default", questionPolicy: { maxRounds: 12, maxPerAgenda: 2 } })
    expect(questionLimit(fresh)).toBe(12)
    const { questionPolicy: _policy, ...legacy } = fresh
    legacy.threshold = 0.05
    legacy.thresholdSource = "otter-default"
    const resumed = dataOf({ data: JSON.parse(JSON.stringify(legacy)) })
    expect(resumed.questionPolicy).toBeUndefined()
    expect(resumed.threshold).toBe(0.05)
    expect(questionLimit(resumed)).toBe(100)
  })

  test("a ready agenda is skipped and an unanswered agenda keeps overall ambiguity at one", () => {
    const d = interview()
    record(d, "agenda-0", 0.1)
    expect(agendaProgress(d)).toMatchObject([{ id: "agenda-0", asked: 1, ambiguity: 0.1, status: "ready" }, { id: "agenda-1", asked: 0, status: "pending" }])
    expect(nextAgenda(d)?.id).toBe("agenda-1")
    expect(finalAmbiguity(d)).toBe(1)
    record(d, "agenda-1", 0.2)
    expect(nextAgenda(d)).toBeUndefined()
    expect(finalAmbiguity(d)).toBe(0.2)
  })

  test("an unresolved agenda is exhausted after two questions", () => {
    const d = interview(1)
    record(d, "agenda-0", 0.6)
    expect(questionBudgetReached(d)).toBe(false)
    record(d, "agenda-0", 0.4)
    expect(agendaProgress(d)).toMatchObject([{ asked: 2, ambiguity: 0.4, status: "exhausted" }])
    expect(nextAgenda(d)).toBeUndefined()
    expect(questionBudgetReached(d)).toBe(true)
  })

  test("twelve total questions stop even when an unanswered agenda remains", () => {
    const d = interview(13)
    for (let i = 0; i < 12; i++) record(d, `agenda-${i}`, 0.1)
    expect(questionBudgetReached(d)).toBe(true)
    expect(finalAmbiguity(d)).toBe(1)
    expect(agendaProgress(d).at(-1)).toMatchObject({ id: "agenda-12", asked: 0, status: "pending" })
  })

  test("persisted agenda attribution, evidence and question keys survive parse and resume", () => {
    const d = interview()
    record(d, "agenda-0", 0.1)
    const resumed = dataOf({ data: JSON.parse(JSON.stringify(d)) })
    expect(resumed.rounds[0]).toMatchObject({ agendaID: "agenda-0", evidence: ["Evidence for agenda-0"], questionKey: "question 1" })
    expect(nextAgenda(resumed)?.id).toBe("agenda-1")
    expect(finalAmbiguity(resumed)).toBe(1)
  })

  test("closure gaps may revisit a ready agenda only while its question budget remains", () => {
    const d = interview(1)
    record(d, "agenda-0", 0.1)
    d.gaps = ["Missing acceptance coverage"]
    expect(nextAgenda(d)?.id).toBe("agenda-0")
    record(d, "agenda-0", 0.1)
    expect(nextAgenda(d)).toBeUndefined()
    expect(questionBudgetReached(d)).toBe(true)
  })
})
