import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"
import { captureSkill } from "../src/skills/capture.ts"
import { FdTree } from "../src/skills/fd-tree.ts"
import { discoverSkills, resolveSkillRoots } from "../src/skills/roots.ts"

const sandboxes: string[] = []
const ENV_KEYS = [
  "PATH",
  "HOME",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "LCA_GIT_REAL",
  "LCA_GIT_LOG",
  "LCA_GIT_MODE",
  "LCA_GIT_CHILD_PID",
  "LCA_GIT_TERM_LOG",
  "LCA_GIT_READY_LOG",
  "LCA_GIT_RELEASE",
] as const

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "lca-git-safety-"))
  sandboxes.push(path)
  return path
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true })
})

function git(binary: string, cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  execFileSync(binary, args, { cwd, env, stdio: "pipe" })
}

function createRepository(root: string, binary: string): string {
  const project = join(root, "project")
  const home = join(root, "home")
  const globalConfig = join(root, "gitconfig")
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(globalConfig, "")
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_CONFIG_GLOBAL = globalConfig
  git(binary, project, env, "init", "--quiet")
  git(binary, project, env, "config", "user.name", "Git Safety Fixture")
  git(binary, project, env, "config", "user.email", "fixture@example.invalid")
  const skillDirectory = join(project, ".agents", "skills", "git-safety")
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: git-safety\ndescription: Git safety fixture.\n---\n")
  git(binary, project, env, "add", "-A")
  git(binary, project, env, "commit", "--quiet", "-m", "fixture")
  return project
}

function createGitWrapper(root: string): string {
  const directory = join(root, "bin")
  mkdirSync(directory)
  const wrapper = join(directory, "git")
  writeFileSync(wrapper, `#!${process.execPath}\nimport { appendFileSync, existsSync } from "node:fs"\nimport { spawnSync } from "node:child_process"\n\nconst args = process.argv.slice(2)\nappendFileSync(process.env.LCA_GIT_LOG, JSON.stringify(args) + "\\n")\nconst isHeadVerification = args.includes("--verify") && args.includes("HEAD")\nconst isRootQuery = args.includes("--show-toplevel")\nconst isCancellationTarget = isHeadVerification || isRootQuery\nif (isCancellationTarget && process.env.LCA_GIT_MODE === "cancel") {\n  appendFileSync(process.env.LCA_GIT_CHILD_PID, String(process.pid) + "\\n")\n  process.on("SIGTERM", () => appendFileSync(process.env.LCA_GIT_TERM_LOG, String(process.pid) + "\\n"))\n  setInterval(() => { if (existsSync(process.env.LCA_GIT_RELEASE)) process.exit(0) }, 10)\n  appendFileSync(process.env.LCA_GIT_READY_LOG, String(process.pid) + "\\n")\n} else if (isHeadVerification && process.env.LCA_GIT_MODE === "timeout") {\n  appendFileSync(process.env.LCA_GIT_CHILD_PID, String(process.pid))\n  process.on("SIGTERM", () => appendFileSync(process.env.LCA_GIT_TERM_LOG, String(process.pid) + "\\n"))\n  setInterval(() => {}, 1000)\n} else if (isHeadVerification && process.env.LCA_GIT_MODE === "overflow") {\n  appendFileSync(process.env.LCA_GIT_CHILD_PID, String(process.pid))\n  process.on("SIGTERM", () => appendFileSync(process.env.LCA_GIT_TERM_LOG, String(process.pid) + "\\n"))\n  process.stdout.write(Buffer.alloc(65 * 1024 * 1024, 0x61))\n  setInterval(() => {}, 1000)\n} else {\n  const result = spawnSync(process.env.LCA_GIT_REAL, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" })\n  if (result.error) {\n    process.stderr.write(String(result.error))\n    process.exitCode = 127\n  } else process.exitCode = result.status ?? 1\n}\n`)
  chmodSync(wrapper, 0o755)
  return directory
}

function installGitFixture(root: string, mode = "delegate"): () => void {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const realGit = Bun.which("git")
  if (!realGit) throw new Error("Git executable is required for this test")
  const wrapperDirectory = createGitWrapper(root)
  process.env.PATH = `${wrapperDirectory}${delimiter}${process.env.PATH ?? ""}`
  process.env.HOME = join(root, "home")
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig")
  process.env.LCA_GIT_REAL = realGit
  process.env.LCA_GIT_LOG = join(root, "git-args.jsonl")
  process.env.LCA_GIT_MODE = mode
  process.env.LCA_GIT_CHILD_PID = join(root, "child-pid")
  process.env.LCA_GIT_TERM_LOG = join(root, "term-pids")
  process.env.LCA_GIT_READY_LOG = join(root, "ready-pids")
  process.env.LCA_GIT_RELEASE = join(root, "release")
  return () => {
    for (const key of ENV_KEYS) {
      const value = original[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function captureFixture(project: string) {
  const roots = await resolveSkillRoots({ projectRoot: project })
  const descriptor = (await discoverSkills(roots)).descriptors.find((item) => item.name === "git-safety")
  if (!descriptor || descriptor.kind !== "skill") throw new Error("Git safety fixture skill was not discovered")
  return captureSkill(roots, descriptor)
}

async function waitForPidLines(path: string, count: number): Promise<number[]> {
  const readPids = (): number[] => existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(Number)
    : []
  // Poll: fs.watch on Linux (inotify) can drop append events from concurrent writers in different processes.
  const deadline = Date.now() + 4000
  for (;;) {
    const pids = readPids()
    if (pids.length >= count) return pids
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await Bun.sleep(10)
  }
}

function expectProcessExited(pid: number): void {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return
    throw error
  }
  throw new Error(`Git child ${pid} remained alive after capture settled`)
}

describe("Git subprocess capture safety", () => {
  test("uses real Git with no-lazy-fetch and the existing noninteractive safety options", async () => {
    const root = sandbox()
    const realGit = Bun.which("git")
    if (!realGit) throw new Error("Git executable is required for this test")
    const project = createRepository(root, realGit)
    const restore = installGitFixture(root)
    try {
      const capture = await captureFixture(project)
      expect(capture.classification).toBe("common")
      const invocations = readFileSync(join(root, "git-args.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      expect(invocations.length).toBeGreaterThan(0)
      for (const args of invocations) {
        expect(args.slice(0, 5)).toEqual([
          "--no-lazy-fetch",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
        ])
        expect(args).not.toContain("fetch")
      }
    } finally {
      restore()
    }
  })

  test("an already-aborted capture starts no Git child and performs no source enumeration", async () => {
    const root = sandbox()
    const realGit = Bun.which("git")
    if (!realGit) throw new Error("Git executable is required for this test")
    const project = createRepository(root, realGit)
    const roots = await resolveSkillRoots({ projectRoot: project })
    const descriptor = (await discoverSkills(roots)).descriptors.find((item) => item.name === "git-safety")
    if (!descriptor || descriptor.kind !== "skill") throw new Error("Git safety fixture skill was not discovered")
    const restore = installGitFixture(root)
    const controller = new AbortController()
    controller.abort()
    const originalList = FdTree.prototype.list
    let enumerations = 0
    FdTree.prototype.list = function (this: FdTree, directory: Parameters<FdTree["list"]>[0]) {
      enumerations++
      return originalList.call(this, directory)
    }
    try {
      await expect(captureSkill(roots, descriptor, { signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
        message: "Skill source operation was aborted",
      })
      expect(enumerations).toBe(0)
      expect(existsSync(join(root, "git-args.jsonl"))).toBe(false)
    } finally {
      FdTree.prototype.list = originalList
      restore()
    }
  })

  test("times out or stops on output overflow, escalates SIGTERM to SIGKILL, and settles only after child close", async () => {
    for (const mode of ["timeout", "overflow"] as const) {
      const root = sandbox()
      const realGit = Bun.which("git")
      if (!realGit) throw new Error("Git executable is required for this test")
      const project = createRepository(root, realGit)
      const restore = installGitFixture(root, mode)
      try {
        const expectedMessage = mode === "timeout"
          ? "Git subprocess exceeded its 15000ms deadline"
          : "Git output exceeds the capture limit"
        await expect(captureFixture(project)).rejects.toMatchObject({
          name: "SkillCaptureError",
          reason: "refused",
          message: expectedMessage,
        })
        const pid = Number(readFileSync(join(root, "child-pid"), "utf8"))
        expect(Number.isInteger(pid)).toBe(true)
        expect(readFileSync(join(root, "term-pids"), "utf8")).toContain(`${pid}\n`)
        expectProcessExited(pid)
      } finally {
        restore()
      }
    }
  }, { timeout: 30_000 })

  test("aborts all ready Git children and settles only after both owned children close", async () => {
    const root = sandbox()
    const realGit = Bun.which("git")
    if (!realGit) throw new Error("Git executable is required for this test")
    const project = createRepository(root, realGit)
    const roots = await resolveSkillRoots({ projectRoot: project })
    const descriptor = (await discoverSkills(roots)).descriptors.find((item) => item.name === "git-safety")
    if (!descriptor || descriptor.kind !== "skill") throw new Error("Git safety fixture skill was not discovered")
    const restore = installGitFixture(root, "cancel")
    const controller = new AbortController()
    let settled = false
    const pending = captureSkill(roots, descriptor, { signal: controller.signal }).then(
      value => { settled = true; return { value, error: undefined } },
      error => { settled = true; return { value: undefined, error } },
    )
    try {
      const pids = await waitForPidLines(join(root, "ready-pids"), 2)
      expect(pids).toHaveLength(2)
      controller.abort()
      const terminated = await waitForPidLines(join(root, "term-pids"), 2)
      expect(new Set(terminated)).toEqual(new Set(pids))
      expect(settled).toBe(false)
      expect((await pending).error).toMatchObject({ name: "AbortError", message: "Skill source operation was aborted" })
      expect(settled).toBe(true)
      for (const pid of pids) expectProcessExited(pid)
      const invocations = readFileSync(join(root, "git-args.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      expect(invocations.some((args) => args[0] === "check-attr")).toBe(false)
    } finally {
      controller.abort()
      writeFileSync(join(root, "release"), "release")
      await pending.catch(() => undefined)
      restore()
    }
  })
})
