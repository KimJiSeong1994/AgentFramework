import { expect, test } from "bun:test"
import { parseMarkdown } from "../src/tui/markdown.ts"
import { displayWidth, transcriptDisplayRows, transcriptRowText } from "../src/tui/render.ts"

const table = [
  "| 구성 | 역할 | 현재 상태 |", "|---|---|---|",
  "| `src/siteplan_analysis/stage1/pdf_processor.py` | 도면 이미지와 텍스트를 변환하고 저장하는 전처리 구현 | 실행 미검증 |",
  "| `tests/` | 기존 테스트와 제품 코드의 정합성을 확인 | 다른 패키지 대상 |",
].join("\n")
const lines = (text: string) => text.split("\n").map((line, index) => index ? `  | ${line}` : `[Assistant] ${line}`)

test.each([60, 80, 120])("Korean table keeps cells readable within %i columns", columns => {
  const rows = transcriptDisplayRows(lines(table), columns).map(transcriptRowText)
  expect(rows.every(row => displayWidth(row) <= columns)).toBe(true)
  expect(rows.join("\n")).not.toContain("|---|")
  expect(rows.join("\n")).toContain("실행 미검증")
  expect(rows.join("\n")).toContain("다른 패키지 대상")
  expect(rows.join("\n")).toContain("│")
  expect(parseMarkdown(table)[0]?.kind).toBe("table")
})

test("escaped pipes and pipes inside inline code remain within their cells", () => {
  const blocks = parseMarkdown("| 값 | 설명 |\n|---|---|\n| a\\|b | `x|y` |")
  expect(blocks).toEqual([{ kind: "table", headers: [
    [{ text: "값", styles: [] }], [{ text: "설명", styles: [] }],
  ], rows: [[[{ text: "a|b", styles: [] }], [{ text: "x|y", styles: ["inline-code"] }]]] }])
})

test("fenced table examples stay code and malformed separators stay prose", () => {
  const code = "```text\n" + table + "\n```"
  expect(parseMarkdown(code)[0]).toMatchObject({ kind: "code", lines: table.split("\n") })
  expect(parseMarkdown("| A | B |\n|---|---|\n```text\n| C | D |\n``` ").map(block => block.kind)).toEqual(["table", "code"])
  expect(parseMarkdown("a | b\nnot | a divider").every(block => block.kind === "paragraph")).toBe(true)
})

test("many columns fall back to labelled fields without overflowing", () => {
  const source = "| 항목 | 상태 | 위치 | 역할 | 근거 |\n|---|---|---|---|---|\n| 이름 | 완료 | 저장소 | 분석 | 확인함 |"
  const rows = transcriptDisplayRows(lines(source), 40).map(transcriptRowText)
  expect(rows.every(row => displayWidth(row) <= 40)).toBe(true)
  expect(rows.join("\n")).toContain("항목: 이름")
  expect(rows.join("\n")).toContain("근거: 확인함")
})

test("ASCII tables and terminal control characters use existing sanitization", () => {
  const source = "| A | B |\n|---|---|\n| \u001b[31mred | value |"
  const text = transcriptDisplayRows(lines(source), 60, true).map(transcriptRowText).join("\n")
  expect(text).toContain(" | ")
  expect(text).not.toContain("\u001b")
})
