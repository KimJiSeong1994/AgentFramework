import { expect, test } from "bun:test"
import { assistantDisplayText } from "../src/hosts/terminal-text.ts"
import { transcriptDisplayRows, transcriptRowText } from "../src/tui/render.ts"

test("repairs escaped report paragraphs, headings and table rows for display", () => {
  const report = String.raw`종합 판단\n\n검토 결과입니다.\n\n## 구성\n\n| 구성 | 역할 |\n|---|---|\n| main.py | 진입점 |`
  const expected = report.replaceAll("\\n", "\n")
  expect(assistantDisplayText(report)).toBe(expected)
  const rows = transcriptDisplayRows([`[Assistant] ${report}`], 100).map(transcriptRowText).join("\n")
  expect(rows).not.toContain("\\n")
  expect(rows).toContain("main.py")
  const userRows = transcriptDisplayRows([`[You] ${report}`], 100).map(transcriptRowText).join("\n")
  expect(userRows).toContain("\\n")
})

test("preserves normal prose, code, JSON, paths and intentional escape explanations", () => {
  for (const text of ["normal\n\n## Heading\ntext", String.raw`Use \n to separate lines`,
    String.raw`C:\new\notes\next`, JSON.stringify({ text: String.raw`a\n\n## h\nb` }),
    '```js\nconst text = "a\\n\\nb";\n```']) expect(assistantDisplayText(text)).toBe(text)
  const report = 'Summary\\n\\n## Example\\nUse `"a\\n"` literally.\\n\\n```js\\nconst s = "a\\n";\\n```'
  const result = assistantDisplayText(report)
  expect(result).toContain('Use `"a\\n"` literally.')
  expect(result).toContain('```js\\nconst s = "a\\n";\\n```')
  expect(result).toStartWith("Summary\n\n## Example\n")
  expect(assistantDisplayText(result)).toBe(result)
})

test("does not decode Unicode controls", () => {
  const result = assistantDisplayText(String.raw`Summary\n\n## Result\n\u001b[31m\nEnd`)
  expect(result).toContain(String.raw`\u001b[31m`)
  expect(result).not.toContain("\u001b")
})

test("ambiguous unquoted Windows paths within a report disable recovery", () => {
  for (const path of [String.raw`C:\new\notes\next`, String.raw`\\network\new`]) {
    const report = String.raw`Summary\n\n## Paths\n` + path + String.raw`\nDone`
    expect(assistantDisplayText(report)).toBe(report)
  }
})

test("fences remain opaque even with embedded template literals or tilde delimiters", () => {
  for (const code of [
    '~~~js\\nconst s = "a\\n";\\n~~~',
    '```js\\nconst s = `a\\n`;\\n```',
    '``example `a\\n` here``',
    '```js\\nconst unfinished = `a\\n`',
  ]) {
    const prefix = 'Summary\\n\\n## Example\\n'
    expect(assistantDisplayText(prefix + code)).toBe("Summary\n\n## Example\n" + code)
  }
})
