import { describe, expect, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"

type TestApp = { input(event: unknown): void; choice?: { focus: string; documentOffset: number; selected: number; windowStart: number } }

describe("approval and generic choice focus", () => {
  test("approval document navigation and paste cannot decide", async () => {
    const tui = new TuiApp()
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
