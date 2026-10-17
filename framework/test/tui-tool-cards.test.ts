// GJC-style tool cards: tool target/duration on a display-only channel, and Bash/Verify cards with duration.
import { describe, expect, test } from "bun:test"
import { cliToolDetail, validatedToolDetail } from "../src/hosts/cli-progress.ts"
import { formatDuration } from "../src/tui/progress.ts"
import { toolTarget, TranscriptModel } from "../src/tui/transcript-model.ts"
import { transcriptDisplayRows, transcriptRowText } from "../src/tui/render.ts"
import { restoreTranscript } from "../src/tui/session-transcript.ts"

const base = { role: "worker" as const, execution: 1, taskID: "t1", executionID: "e1" }
const rows = (model: TranscriptModel, width = 90) => transcriptDisplayRows(model.lines(), width).map(transcriptRowText)

describe("tool detail projection", () => {
  test("keeps paths, patterns, ranges and line counts but never file contents", () => {
    const secret = "TOKEN=abc123 do-not-show"
    expect(cliToolDetail("read", { path: "src/a.ts", startLine: 120, maxLines: 21 })).toEqual({ path: "src/a.ts", offset: 120, limit: 21 })
    expect(cliToolDetail("grep", { pattern: "todo", path: "src" })).toEqual({ path: "src", pattern: "todo" })
    const write = cliToolDetail("write", { path: "calc.py", content: `${secret}\nline 2\n` })
    expect(write).toEqual({ path: "calc.py", added: 2 })
    const edit = cliToolDetail("edit", { path: "calc.py", oldText: `${secret}\n`, newText: "a\nb\nc" })
    expect(edit).toEqual({ path: "calc.py", added: 3, removed: 1 })
    expect(JSON.stringify([write, edit])).not.toContain("TOKEN")
    expect(cliToolDetail("read", null)).toBeUndefined()
    expect(cliToolDetail("glob", { pattern: 7 })).toBeUndefined()
  })

  test("validation drops unknown keys, control characters and negative or non-integer counts", () => {
    const detail = validatedToolDetail({ path: "a\u001b[2Jb", content: "body", offset: -1, limit: 1.5, added: 4, extra: true })
    expect(detail).toEqual({ path: "a [2Jb", added: 4 })
    expect(validatedToolDetail({ path: "x".repeat(600) })!.path!.length).toBe(512)
    expect(validatedToolDetail("nope")).toBeUndefined()
  })

  test("targets read like GJC and never contain the row separator", () => {
    expect(toolTarget("read", { path: "src/a.ts", offset: 120, limit: 21 })).toBe("src/a.ts:120-140")
    expect(toolTarget("read", { path: "src/a.ts" })).toBe("src/a.ts")
    expect(toolTarget("grep", { pattern: "x", path: "src" })).toBe('"x" in src')
    expect(toolTarget("edit", { path: "a.ts", added: 1, removed: 0 })).toBe("a.ts ⟦+1 / -0⟧")
    expect(toolTarget("read", { path: "a · b.ts" })).toBe("a - b.ts")
    expect(toolTarget("list", undefined)).toBe("")
  })

  test("durations", () => {
    expect([0, 42, 999, 1830, 12_400, 125_000, -5, Number.NaN].map(formatDuration)).toEqual(["0ms", "42ms", "999ms", "1.8s", "12s", "2m05s", "0ms", "0ms"])
  })
})

describe("transcript tool rows", () => {
  test("a call shows its target and duration from the display channel; activity alone stays outcome-only", () => {
    let now = 1000
    const model = new TranscriptModel("s", () => now)
    model.activity({ kind: "tool-started", ...base, callID: "c1", tool: "read" }, 1)
    model.toolDisplay({ executionID: "e1", callID: "c1", phase: "started", detail: { path: "framework/test/a.ts", offset: 120, limit: 21 } })
    now = 1042
    model.activity({ kind: "tool-finished", ...base, callID: "c1", tool: "read", outcome: "succeeded", ok: true }, 1)
    model.toolDisplay({ executionID: "e1", callID: "c1", phase: "finished", durationMs: 42, detail: { resultLines: 21 } })
    model.activity({ kind: "tool-started", ...base, callID: "c2", tool: "list" }, 2)
    now = 1500
    expect(rows(model)).toEqual([
      "✔ Read framework/test/a.ts:120-140 · 42ms",
      "  ▸ #1 · execution not observed · task title unavailable · t1",
      "⟳ List · 458ms",
      "  ▸ #2 · execution not observed · task title unavailable · t1",
    ])
    model.toggle("tool:[\"e1\",\"c1\"]")
    expect(model.lines()).toContain("  Result: 21 lines")
  })

  test("display that arrives before the lifecycle row is merged when the row appears", () => {
    const model = new TranscriptModel("s", () => 0)
    model.toolDisplay({ executionID: "e1", callID: "c9", phase: "started", detail: { path: "calc.py", added: 2, removed: 1 } })
    model.activity({ kind: "tool-started", ...base, callID: "c9", tool: "edit" }, 1)
    expect(rows(model)[0]).toBe("⟳ Edit calc.py ⟦+2 / -1⟧ · 0ms")
  })

  test("a failed call shows its bounded error when expanded; restored calls never gain live detail", () => {
    const model = new TranscriptModel("s", () => 0)
    model.activity({ kind: "tool-started", ...base, callID: "c3", tool: "grep" }, 1)
    model.toolDisplay({ executionID: "e1", callID: "c3", phase: "finished", durationMs: 15, detail: { error: "path not found" } })
    model.activity({ kind: "tool-finished", ...base, callID: "c3", tool: "grep", outcome: "failed", ok: false }, 1)
    model.toggle("tool:[\"e1\",\"c3\"]")
    expect(model.lines()).toContain("  Error: path not found")
    expect(rows(model)[1]).toBe("  ▾ #1 · call failed · execution not observed · task title unavailable · t1")

    const restored = new TranscriptModel("s", () => 0)
    restored.activity({ kind: "tool-started", ...base, callID: "c4", tool: "read" }, 1, true)
    restored.toolDisplay({ executionID: "e1", callID: "c4", phase: "started", detail: { path: "secret.txt" } })
    expect(restored.lines().join("\n")).not.toContain("secret.txt")
  })
})

describe("Bash and Verify cards", () => {
  test("operator shell: titled card, full command, Output divider, exit and duration footer", () => {
    const model = new TranscriptModel("s", () => 0)
    model.shellStarted("sh1", "cd framework && bun test test/cli-progress.test.ts 2>&1 | grep -E '^\\s*[0-9]+ (pass|fail)'")
    model.shellFinished("sh1", { status: "complete", exitCode: 0, signal: null, durationMs: 1830, lines: [" 7 pass", " 0 fail"], totalLines: 2 })
    const card = rows(model, 60)
    expect(card[0]).toMatch(/^┌─── ✔ Bash ─+┐$/u)
    expect(card.slice(1, 3).map(line => line.slice(2).trimEnd().replace(/ │$/u, "")).join(" ").replace(/\s+/gu, " "))
      .toContain("$ cd framework && bun test test/cli-progress.test.ts 2>&1 | grep -E")
    expect(card).toContainEqual(expect.stringMatching(/^├─── Output ─+┤$/u))
    expect(card).toContainEqual(expect.stringMatching(/^│ {2}7 pass\s+│$/u))
    expect(card).toContainEqual(expect.stringMatching(/^│ ⟦exit 0 · 1\.8s⟧\s+│$/u))
    expect(card.at(-1)).toMatch(/^└─+┘$/u)
    for (const line of card) expect([...line].length).toBe(60)
  })

  test("verify run: Verify title with task, attempt shown after the first, timeout in the footer", () => {
    const model = new TranscriptModel("s", () => 0)
    model.shellStarted("v1", "python3 -m unittest discover", undefined, { source: "verify", taskID: "t2", attempt: 2, timeoutMs: 120_000 })
    model.shellFinished("v1", { status: "error", exitCode: 1, signal: null, durationMs: 2400, lines: ["FAILED (errors=1)"], totalLines: 1 })
    const card = rows(model, 70)
    expect(card[0]).toMatch(/^┌─── ✘ Verify · t2 · attempt 2 ─+┐$/u)
    expect(card).toContainEqual(expect.stringMatching(/^│ \$ python3 -m unittest discover\s+│$/u))
    expect(card).toContainEqual(expect.stringMatching(/^│ ⟦exit 1 · 2\.4s · timeout 2m00s⟧\s+│$/u))
    const ascii = transcriptDisplayRows(model.lines(), 70, true).map(transcriptRowText)
    expect(ascii[0]).toMatch(/^\+--- x Verify · t2 · attempt 2 -+\+$/u)
    expect(ascii).toContainEqual(expect.stringMatching(/^\| \[exit 1 · 2\.4s · timeout 2m00s\]\s+\|$/u))
  })

  test("a stored verify record restores as the same card", () => {
    const model = new TranscriptModel("s", () => 0)
    restoreTranscript(model, [{ seq: 1, kind: "verify", eventID: "verify:t1:1:x", data: {
      taskID: "t1", attempt: 1, command: "bun test", status: "complete", exitCode: 0, durationMs: 950, timeoutMs: 60_000, lines: ["ok"], totalLines: 1,
    } }])
    const card = rows(model, 60)
    expect(card[0]).toMatch(/^┌─── ✔ Verify · t1 ─+┐$/u)
    expect(card).toContainEqual(expect.stringMatching(/^│ ⟦exit 0 · 950ms · timeout 1m00s⟧\s+│$/u))
    expect(() => restoreTranscript(new TranscriptModel("s"), [{ seq: 1, kind: "verify", eventID: "verify:bad", data: { taskID: "t1" } }])).toThrow("invalid stored verify run")
  })
})
