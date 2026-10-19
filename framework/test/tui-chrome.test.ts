import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ellipsize, renderFrame } from "../src/tui/render.ts"
import { displayPath, gitBranch, workspaceLabel, WorkspaceLabel } from "../src/tui/workspace.ts"
import { statusLines } from "../src/tui/status-view.ts"
import type { InteractiveViewFacts } from "../src/hosts/interactive-view.ts"

const rows = (value: string): string[] => [...value.matchAll(/\u001b\[\d+;1H\u001b\[2K((?:[^\u001b]|\u001b\[[0-9;]*m)*)/g)]
  .map(match => match[1]!.replace(/\u001b\[[0-9;]*m/g, "").trimEnd())
const composerRow = (frame: string): string => rows(frame).find(row => row.startsWith("│ You>")) ?? ""

const frame = (overrides: Partial<Parameters<typeof renderFrame>[0]> = {}) => renderFrame({
  columns: 80, rows: 24, transcript: ["[You] hi"], status: "ready", draft: "", cursor: 0, prompt: "You> ", color: true, ...overrides,
})

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function repo(head: string): string {
  const root = mkdtempSync(join(tmpdir(), "otter-ws-"))
  temporary.push(root)
  mkdirSync(join(root, ".git"))
  writeFileSync(join(root, ".git", "HEAD"), head)
  return root
}

describe("composer placeholder", () => {
  test("shows a muted hint in an empty colored composer and keeps the cursor after the prompt", () => {
    const output = frame({ placeholder: "Type a message · / commands" })
    expect(composerRow(output)).toBe(`│ ${"You> Type a message · / commands".padEnd(76)} │`)
    expect(output).toMatch(/You> \u001b\[[0-9;]*m+Type a message/u)
    const cursor = output.match(/\u001b\[(\d+);(\d+)H$/u)!
    expect(Number(cursor[2])).toBe(8)
  })

  test("disappears once there is a draft and under NO_COLOR, where it would read as typed text", () => {
    expect(composerRow(frame({ placeholder: "Type a message", draft: "x", cursor: 1 }))).toBe(`│ ${"You> x".padEnd(76)} │`)
    expect(composerRow(frame({ placeholder: "Type a message", color: false }))).toBe(`│ ${"You> ".padEnd(76)} │`)
  })

  test("is clipped with an ellipsis to the composer width", () => {
    const row = composerRow(frame({ columns: 60, placeholder: `hint ${"word ".repeat(20)}` }))
    expect(row).toBe(`│ You> ${"hint word word word word word word word word word…".padEnd(51)} │`)
  })
})

describe("rule bar workspace context", () => {
  test("follows the model badge and gives way to the screen name", () => {
    const output = rows(frame({ header: { screen: "Chat", selection: "codex / gpt", context: "⑂ main / ~/repo" } }))
    expect(output.find(row => row.startsWith(" ⬢ codex / gpt / ⑂ main / ~/repo ─"))).toBeDefined()
    const narrow = rows(frame({ columns: 60, header: { screen: "Chat", selection: "codex / gpt", context: `⑂ main / ~/${"x".repeat(80)}` } }))
    const rule = narrow.find(row => row.startsWith(" ⬢ codex / gpt / ⑂ main"))!
    expect(rule).toContain("…")
    expect(rule.endsWith("Otter")).toBe(true)
  })
})

describe("ellipsize", () => {
  test("keeps text that fits and marks clipped text", () => {
    expect(ellipsize("short", 10)).toBe("short")
    expect(ellipsize("abcdefghij", 6)).toBe("abcde…")
    expect(ellipsize("abcdefghij", 6, true)).toBe("abc...")
    expect(ellipsize("한글한글", 5)).toBe("한글…")
  })
})

describe("workspace label", () => {
  test("reads the branch, a detached sha, and a linked worktree pointer", () => {
    expect(gitBranch(repo("ref: refs/heads/feat/tui\n"))).toBe("feat/tui")
    expect(gitBranch(repo("0123456789abcdef0123456789abcdef01234567\n"))).toBe("0123456")
    const main = repo("ref: refs/heads/main\n")
    const linked = mkdtempSync(join(tmpdir(), "otter-wt-"))
    temporary.push(linked)
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true })
    writeFileSync(join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/side\n")
    writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`)
    mkdirSync(join(linked, "src"))
    expect(gitBranch(join(linked, "src"))).toBe("side")
  })

  test("formats ~ paths and omits the branch outside a repository", () => {
    expect(displayPath("/home/me/work", "/home/me")).toBe("~/work")
    expect(displayPath("/home/meow", "/home/me")).toBe("/home/meow")
    const root = repo("ref: refs/heads/main\n")
    expect(workspaceLabel(root, false)).toEndWith(` / ${displayPath(root)}`)
    expect(workspaceLabel(root, false)).toStartWith("⑂ main")
    expect(workspaceLabel(root, true)).toStartWith("git:main")
  })

  test("caches for two seconds, then picks up a branch switch", () => {
    const root = repo("ref: refs/heads/one\n")
    const label = new WorkspaceLabel(() => root)
    expect(label.value(false, 0)).toStartWith("⑂ one")
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/two\n")
    expect(label.value(false, 1000)).toStartWith("⑂ one")
    expect(label.value(false, 2500)).toStartWith("⑂ two")
  })
})

describe("held status explanation", () => {
  test("says in words that another session owns the active workflow", () => {
    const facts = {
      identity: { mode: "writable", sessionID: "s1", epoch: "e" },
      selection: { engine: "codex", model: "gpt" },
      hold: { state: "known", value: { held: false } },
      request: { state: "not-observed" },
      discovery: "ok",
      workflow: { state: "known", value: { id: "wf_1", kind: "deep-interview", stage: "interview", phase: "planning", revision: 3 } },
      owner: "foreign",
      claim: { state: "known", value: false },
      fence: { state: "known", value: false },
      termination: "not-observed",
    } as unknown as InteractiveViewFacts
    const text = statusLines({ facts, activity: "idle", queued: 0, columns: 200, selectionInHeader: true }).join(" ")
    expect(text).toContain("owner:foreign")
    expect(text).toContain("deep-interview workflow owned by another session")
  })
})
