import { describe, expect, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"

type TestApp = {
  input(event: unknown): void
  draw(): void
  driver: { write(frame: string): void }
  dimensions(): { columns: number; rows: number }
  choice?: { focus: string; documentOffset: number; selected: number; windowStart: number }
}

const plain = (frame: string | undefined): string => (frame ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
const frameRows = (frame: string | undefined): string[] => [...(frame ?? "").matchAll(/\u001b\[\d+;1H\u001b\[2K((?:[^\u001b]|\u001b\[[0-9;]*m)*)/gu)]
  .map(match => match[1]!.replace(/\u001b\[[0-9;]*m/gu, "").trimEnd())

function setup(columns: number, rows: number) {
  const tui = new TuiApp()
  tui.resume = () => {}
  const internal = tui as unknown as TestApp
  const size = { columns, rows }
  internal.dimensions = () => size
  const frames: string[] = []
  internal.driver.write = frame => frames.push(frame)
  return {
    tui, internal, frames, last: () => plain(frames.at(-1)),
    resize: (nextColumns: number, nextRows: number) => {
      size.columns = nextColumns
      size.rows = nextRows
      internal.draw()
    },
  }
}

describe("approval and generic choice focus", () => {
  test("approval keeps the latest conversation above a scrollable decision panel and visible composer", async () => {
    const { tui, internal, frames, last, resize } = setup(60, 20)
    tui.writeText({ provenance: "assistant", text: "Prepared Café 👩‍💻 and 한글 for review." })
    const draft = Array.from({ length: 8 }, (_, index) => `approval draft row ${index + 1}`).join("\n")
    tui.setDraft(draft)
    const values = Array.from({ length: 12 }, (_, index) => `Pending decision ${index + 1} ${"detail ".repeat(12)}`)
    const result = tui.choose("Review canonical plan", values, new AbortController().signal, {
      kind: "approval",
      document: "Approval document starts here.\nNext document row",
      binding: { sessionID: "session-1", workflowID: "workflow-1", expectedRevision: 3, planSha: "a".repeat(64), path: "plan.md" },
    })
    let settled = false
    void result.then(() => { settled = true })

    const initialRows = frameRows(frames.at(-1))
    const transcriptRow = initialRows.findIndex(row => row.includes("Prepared Café 👩‍💻 and 한글 for review."))
    const panelTop = initialRows.findIndex(row => row.startsWith("╭─ Review canonical plan · document focus"))
    const composerPrompt = initialRows.findIndex(row => row.includes("approval draft row 5"))
    const panelBottom = initialRows.findIndex((row, index) => index > panelTop && row.startsWith("╰"))
    expect(transcriptRow).toBeGreaterThanOrEqual(0)
    expect(panelTop).toBeGreaterThan(transcriptRow)
    expect(initialRows.some(row => row.includes("source plan.md"))).toBe(true)
    expect(initialRows.some(row => row.includes("Approval document starts here."))).toBe(true)
    expect(initialRows.some(row => row.includes("> Pending decision"))).toBe(false)
    expect(panelBottom + 1).toBe(composerPrompt - 1)
    expect(initialRows.every(row => row.length <= 60)).toBe(true)

    internal.input({ type: "key", key: "pageDown" })
    expect(last()).toContain("Next document row")
    internal.input({ type: "paste", text: "Approve" })
    internal.input({ type: "key", key: "enter" })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(internal.choice?.focus).toBe("document")
    internal.input({ type: "key", key: "tab" })
    internal.input({ type: "text", text: "Approve" })
    await Promise.resolve()
    expect(settled).toBe(false)
    for (let index = 0; index < values.length - 1; index += 1) internal.input({ type: "key", key: "down" })
    expect(internal.choice?.selected).toBe(values.length - 1)
    expect(last()).toContain("> Pending decision 12")
    resize(100, 30)
    expect(last()).toContain("> Pending decision 12")
    expect(last()).toContain("approval draft row 1")
    expect(frameRows(frames.at(-1)).some(row => row.includes("Prepared Café 👩‍💻 and 한글 for review."))).toBe(true)
    resize(60, 20)
    expect(last()).toContain("> Pending decision 12")
    const finalCursor = frames.at(-1)?.match(/\u001b\[(\d+);(\d+)H$/u)
    expect(finalCursor).not.toBeNull()
    expect(Number(finalCursor?.[1])).toBeLessThanOrEqual(20)
    expect(Number(finalCursor?.[2])).toBeLessThanOrEqual(60)
    internal.input({ type: "key", key: "enter" })
    expect(await result).toBe(values.length - 1)
    expect(tui.draftSnapshot().draft).toBe(draft)
    tui.close()
  })

  test("approval document navigation and paste cannot decide", async () => {
    const tui = new TuiApp()
    tui.resume = () => {}
    const internal = tui as unknown as TestApp
    const controller = new AbortController()
    const result = tui.choose("Decision", ["Approve", "Reject", "Keep pending"], controller.signal, {
      kind: "approval",
      document: Array.from({ length: 250 }, (_, index) => `row ${index}`).join("\n"),
      binding: { sessionID: "s", workflowID: "w", expectedRevision: 4, planSha: "a".repeat(64), path: "plan.md" },
    })
    internal.input({ type: "key", key: "pageDown" })
    internal.input({ type: "paste", text: "\nApprove\n" })
    internal.input({ type: "key", key: "enter" })
    expect(internal.choice?.focus).toBe("document")
    expect(internal.choice?.documentOffset).toBeGreaterThan(0)
    internal.input({ type: "key", key: "tab" })
    internal.input({ type: "key", key: "enter" })
    expect(await result).toBe(0)
    tui.close()
  })

  test("generic chooser pages in original index space", async () => {
    const tui = new TuiApp()
    tui.resume = () => {}
    const internal = tui as unknown as TestApp
    const values = Array.from({ length: 240 }, (_, index) => `session-${index}`)
    const result = tui.choose("Sessions", values, new AbortController().signal, {
      kind: "generic-list",
      rows: values,
      origin: { mode: "retained-read-only", sessionID: "current" },
    })
    internal.input({ type: "key", key: "pageDown" })
    const selected = internal.choice?.selected ?? 0
    expect(selected).toBeGreaterThan(0)
    expect(internal.choice?.windowStart).toBeGreaterThanOrEqual(0)
    internal.input({ type: "key", key: "enter" })
    expect(await result).toBe(selected)
    tui.close()
  })

  test("single long paragraph keeps a visual-row anchor while paging", () => {
    const tui = new TuiApp()
    tui.resume = () => {}
    const internal = tui as unknown as TestApp
    const controller = new AbortController()
    void tui.choose("Decision", ["Approve", "Reject", "Keep pending"], controller.signal, {
      kind: "approval",
      document: "anchor ".repeat(4000),
      binding: { sessionID: "session-with-a-long-identity", workflowID: "workflow-with-a-long-identity", expectedRevision: 9, planSha: "b".repeat(64), path: "nested/very-long/canonical-plan.md" },
    })
    internal.input({ type: "key", key: "pageDown" })
    const first = internal.choice?.documentOffset ?? 0
    internal.input({ type: "key", key: "pageDown" })
    expect(first).toBeGreaterThan(0)
    expect(internal.choice?.documentOffset).toBeGreaterThan(first)
    controller.abort()
    tui.close()
  })
})
