import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliTools } from "../src/hosts/cli-tools.ts"
import { attachAdmission, detachAdmission, holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { pendingSkillPermissionActivityCount } from "../src/skills/activity.ts"
import { resolveSkillRoots } from "../src/skills/roots.ts"
import { claimPreparedSkillInvocation, SkillSession } from "../src/skills/session.ts"
import { tempWorktree } from "./guards-helpers.ts"

const SID = "skill_source_session"
const signal = () => new AbortController().signal
let fixture: ReturnType<typeof tempWorktree>
let runtime: ReturnType<typeof createCliRuntime>
let store: SessionStore
let sessions: SkillSession[]
let choices: string[]
let choose: (title: string, values: readonly string[], signal: AbortSignal) => Promise<number | undefined>

function git(...args: string[]): void { gitIn(fixture.worktree, ...args) }
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "Skill Test", GIT_AUTHOR_EMAIL: "skill@example.test", GIT_COMMITTER_NAME: "Skill Test", GIT_COMMITTER_EMAIL: "skill@example.test", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
  }).toString("utf8").trim()
}
function put(name: string, body = "Use read-only inspection.\r\n"): string {
  const directory = join(fixture.worktree, ".agents", "skills", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Inspect this project\nallowed-tools: [read]\n---\n${body}`)
  return directory
}
function commit(): void { git("add", "-A"); git("commit", "--quiet", "-m", "skill fixture") }
async function source(foreground = true): Promise<SkillSession> {
  const roots = await resolveSkillRoots({ projectRoot: fixture.worktree })
  const session = await SkillSession.create({
    roots, store,
    ...(foreground ? { terminal: { stdinIsTTY: true, stderrIsTTY: true, choose: async (title: string, values: readonly string[], abort: AbortSignal) => {
      choices.push(title)
      return choose(title, values, abort)
    } } } : {}),
  }, signal())
  sessions.push(session)
  return session
}

beforeEach(() => {
  fixture = tempWorktree()
  fixture.worktree = realpathSync.native(fixture.worktree)
  git("init", "--quiet")
  runtime = createCliRuntime({ worktree: fixture.worktree, engine: "local", model: "fixture/model" })
  store = attachAdmission(runtime, SID, { engine: "local", model: "fixture/model" })
  sessions = []
  choices = []
  choose = async () => 0
})
afterEach(() => {
  for (const session of sessions) session.close()
  fixture.cleanup()
})

test("capture activity remains a release and Resume blocker until the cancelled operation settles", async () => {
  put("custom")
  const roots = await resolveSkillRoots({ projectRoot: fixture.worktree })
  const pending = SkillSession.create({ roots, store }, signal()).then(
    session => { session.close(); return new Error("unexpected completed baseline") },
    error => error as Error,
  )
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(1)
  holdAdmission(fixture.worktree, SID, "capture-stop")
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(1)
  expect(() => resumeAdmission(runtime, SID)).toThrow(/permission activity|execution activity/u)
  expect(() => store.release({
    workflowQuiescent: true, evidence: "No workflow exists, but source capture remains unsettled.",
    workflowID: null, revision: null,
  })).toThrow("permission activity")
  expect((await pending).name).toBe("AbortError")
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(0)
  expect(resumeAdmission(runtime, SID)).toBe(store)
  expect(choices).toEqual([])
})

test("revocation cancels source discovery before a first consent choice", async () => {
  put("custom")
  const session = await source()
  const pending = session.prepare("custom", signal()).then(
    () => new Error("unexpected source grant"), error => error as Error,
  )
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(1)
  expect(session.revoke("custom")).toBe(0)
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(1)
  expect((await pending).name).toBe("AbortError")
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(0)
  expect(choices).toEqual([])
  expect(session.listGrants()).toEqual([])
})

test("baseline common instructions preserve exact bytes without consent and hand off only once", async () => {
  put("inspect")
  commit()
  const session = await source()
  const prepared = await session.prepare("inspect", signal())
  expect(choices).toEqual([])
  expect(() => claimPreparedSkillInvocation({ ...prepared })).toThrow("copied")
  const bound = claimPreparedSkillInvocation(prepared)
  expect(bound.text).toBe("---\nname: inspect\ndescription: Inspect this project\nallowed-tools: [read]\n---\nUse read-only inspection.\r\n")
  expect(() => claimPreparedSkillInvocation(prepared)).toThrow("already bound")
  expect(session.listGrants()).toEqual([])
})

test("custom grants are session-local and revocation cannot revive an earlier invocation", async () => {
  put("custom")
  const session = await source()
  const first = claimPreparedSkillInvocation(await session.prepare("custom", signal()))
  await session.prepare("custom", signal())
  expect(choices).toHaveLength(1)
  expect(session.listGrants()).toHaveLength(1)
  expect(session.revoke("custom")).toBe(1)
  expect(session.authorizes(first.capture, first.lease, first.revision)).toBe(false)
  await session.prepare("custom", signal())
  expect(choices).toHaveLength(2)
  expect(session.authorizes(first.capture, first.lease, first.revision)).toBe(false)
})

test("new and changed committed content needs one consent per hash after the baseline", async () => {
  put("inspect", "Original instructions.\n")
  commit()
  const session = await source()
  put("inspect", "Changed instructions.\n")
  put("added")
  commit()
  await session.prepare("inspect", signal())
  await session.prepare("inspect", signal())
  await session.prepare("added", signal())
  expect(choices).toHaveLength(2)
  expect(session.listGrants().map(grant => grant.classification)).toEqual(["common", "common"])
})

test("a post-baseline checkout of another ref prompts once per new hash and restoring the baseline is current clean common", async () => {
  put("inspect", "Baseline instructions.\n")
  commit()
  const main = gitIn(fixture.worktree, "rev-parse", "--abbrev-ref", "HEAD")
  const session = await source()
  await session.prepare("inspect", signal())
  expect(choices).toEqual([])

  git("checkout", "--quiet", "-b", "other")
  put("inspect", "Other ref instructions.\n")
  commit()
  const otherHead = gitIn(fixture.worktree, "rev-parse", "HEAD")
  git("checkout", "--quiet", main)
  git("checkout", "--quiet", otherHead)
  expect(gitIn(fixture.worktree, "rev-parse", "HEAD")).toBe(otherHead)
  await session.prepare("inspect", signal())
  expect(choices).toHaveLength(1)
  await session.prepare("inspect", signal())
  expect(choices).toHaveLength(1)
  expect(session.listGrants()).toHaveLength(1)

  git("checkout", "--quiet", main)
  const restored = await session.prepare("inspect", signal())
  expect(choices).toHaveLength(1)
  expect(claimPreparedSkillInvocation(restored).capture.classification).toBe("common")

  git("checkout", "--quiet", "-b", "third")
  put("inspect", "Third ref instructions.\n")
  commit()
  await session.prepare("inspect", signal())
  await session.prepare("inspect", signal())
  expect(choices).toHaveLength(2)
})

test("a post-baseline git pull from a local bare remote prompts once per new hash and never on repeat", async () => {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "lca-skill-pull-")))
  try {
    put("inspect", "Baseline instructions.\n")
    commit()
    const main = gitIn(fixture.worktree, "rev-parse", "--abbrev-ref", "HEAD")
    const bare = join(sandbox, "remote.git")
    gitIn(sandbox, "init", "--quiet", "--bare", bare)
    git("remote", "add", "origin", bare)
    git("push", "--quiet", "origin", `${main}:${main}`)
    git("branch", "--set-upstream-to", `origin/${main}`)
    const session = await source()
    await session.prepare("inspect", signal())
    expect(choices).toEqual([])

    const clone = join(sandbox, "clone")
    gitIn(sandbox, "clone", "--quiet", bare, clone)
    for (const [index, text] of ["Pulled once.\n", "Pulled twice.\n"].entries()) {
      writeFileSync(join(clone, ".agents", "skills", "inspect", "SKILL.md"), `---\nname: inspect\ndescription: Inspect this project\nallowed-tools: [read]\n---\n${text}`)
      gitIn(clone, "add", "-A")
      gitIn(clone, "-c", "user.name=Remote", "-c", "user.email=remote@example.test", "commit", "--quiet", "-m", `remote ${index}`)
      gitIn(clone, "push", "--quiet", "origin", `HEAD:${main}`)
      const before = gitIn(fixture.worktree, "rev-parse", "HEAD")
      git("-c", "user.name=Local", "-c", "user.email=local@example.test", "pull", "--quiet", "--ff-only")
      expect(gitIn(fixture.worktree, "rev-parse", "HEAD")).not.toBe(before)
      await session.prepare("inspect", signal())
      expect(choices).toHaveLength(index + 1)
      await session.prepare("inspect", signal())
      await session.prepare("inspect", signal())
      expect(choices).toHaveLength(index + 1)
    }
    expect(session.listGrants()).toHaveLength(2)
  } finally { rmSync(sandbox, { recursive: true, force: true }) }
})

test("staged disagreement cannot reuse automatic common authority for identical working bytes", async () => {
  const directory = put("inspect")
  writeFileSync(join(directory, "reference.txt"), "original\n")
  commit()
  const session = await source()
  writeFileSync(join(directory, "reference.txt"), "staged\n")
  git("add", "-A")
  writeFileSync(join(directory, "reference.txt"), "original\n")
  await session.prepare("inspect", signal())
  expect(choices).toHaveLength(1)
  expect(session.listGrants()[0]?.classification).toBe("custom")
})

test("headless custom invocation refuses while a checked baseline common skill remains usable", async () => {
  put("common")
  commit()
  put("custom")
  const session = await source(false)
  await session.prepare("common", signal())
  await expect(session.prepare("custom", signal())).rejects.toThrow("attached foreground CLI")
  expect(session.listGrants()).toEqual([])
  expect(choices).toEqual([])
})

test("changed bytes during a human decision do not create a grant", async () => {
  put("custom", "before\n")
  const session = await source()
  choose = async () => { put("custom", "after\n"); return 0 }
  await expect(session.prepare("custom", signal())).rejects.toThrow("changed during consent")
  expect(session.listGrants()).toEqual([])
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(0)
})

test("held restoration resets the common baseline but never restores a custom grant", async () => {
  put("common", "before\n")
  commit()
  put("custom")
  const first = await source()
  await first.prepare("custom", signal())
  put("common", "after\n")
  git("add", ".agents/skills/common")
  git("commit", "--quiet", "-m", "new common")
  first.close()
  expect(await detachAdmission(runtime, SID, store.epoch, "source-switch")).toBe(true)
  store = attachAdmission(runtime, SID, { engine: "local", model: "fixture/model" })
  const restored = await source()
  expect(restored.listGrants()).toEqual([])
  await expect(restored.prepare("common", signal())).rejects.toThrow("remains held")
  resumeAdmission(runtime, SID)
  choices = []
  await restored.prepare("common", signal())
  expect(choices).toEqual([])
  await restored.prepare("custom", signal())
  expect(choices).toHaveLength(1)
})

test("hold cancellation settles the consent blocker and a late answer cannot grant after Resume", async () => {
  put("custom")
  const session = await source()
  let entered!: () => void
  let answer!: (value: number) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  choose = async () => { entered(); return new Promise<number>(resolve => { answer = resolve }) }
  const pending = session.prepare("custom", signal())
  const refused = pending.then(() => new Error("unexpected source grant"), error => error as Error)
  await started
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(1)
  holdAdmission(fixture.worktree, SID, "source-stop")
  expect((await refused).message).toContain("cancelled")
  expect(pendingSkillPermissionActivityCount(fixture.worktree, SID, store.epoch)).toBe(0)
  resumeAdmission(runtime, SID)
  answer(0)
  await Promise.resolve()
  expect(session.listGrants()).toEqual([])
})

test("revoking an unanswered first invocation cancels its choice without granting later", async () => {
  put("custom")
  const session = await source()
  let entered!: () => void
  let answer!: (value: number) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  choose = async () => { entered(); return new Promise<number>(resolve => { answer = resolve }) }
  const pending = session.prepare("custom", signal())
  const refused = pending.then(() => new Error("unexpected source grant"), error => error as Error)
  await started
  expect(session.revoke("custom")).toBe(0)
  expect((await refused).message).toContain("cancelled")
  answer(0)
  await Promise.resolve()
  expect(session.listGrants()).toEqual([])
})

test("external capture consent never becomes instruction, tool, or outside-write authority", async () => {
  const directory = put("external")
  const target = join(fixture.stateHome, "outside.txt")
  writeFileSync(target, "outside reference bytes\n")
  symlinkSync(target, join(directory, "reference.txt"))
  const session = await source()
  const policyID = runtime.policy.resolve("main").id
  choose = async title => title.startsWith("External skill capture") ? 0 : 1
  await expect(session.prepare("external", signal())).rejects.toThrow("denied")
  expect(choices).toHaveLength(2)
  expect(session.captureReadScopes()).toEqual([target])
  expect(session.listGrants()).toEqual([])
  const tools = createCliTools({ root: fixture.worktree, role: "main", allowed: ["read", "write"], denied: [] })
  expect(tools.execute("read", { path: target }).ok).toBe(false)
  expect(tools.execute("write", { path: "new.txt", content: "no" }).ok).toBe(false)
  expect(runtime.policy.resolve("main").id).toBe(policyID)
})

test("protected workflow names cannot be expanded through ordinary source consent", async () => {
  put("deep-interview", "Unchecked replacement instructions.\n")
  const session = await source()
  const catalog = await session.catalog(signal())
  expect(catalog.entries.find(entry => entry.descriptor.name === "deep-interview")?.descriptor.kind).toBe("protected-workflow")
  await expect(session.prepare("deep-interview", signal())).rejects.toThrow("Protected workflow")
  expect(choices).toEqual([])
})
