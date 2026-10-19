import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { CoreDeps } from "../src/deps.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import type { ExecutionRole } from "../src/hosts/types.ts"
import { createOpenCodeSkillPermissionSource } from "../src/hosts/opencode-skill-source.ts"
import { availableCandidates, type SkillPermissionSource } from "../src/routing/catalog.ts"
import { createSkillRouter } from "../src/routing/router.ts"
import { createConfigSkillPermissionSource, skillPermissionAllowed } from "../src/skills/permission-source.ts"

let worktree: string
let deps: CoreDeps
let server: ReturnType<typeof Bun.serve> | undefined

const allowAll = [
  { permission: "skill", pattern: "*", action: "allow" },
]

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "otter-skill-source-"))
  const config = structuredClone(DEFAULT_CONFIG)
  config.skills.allow = ["plan", "review"]
  config.skill_router.mode = "shadow"
  config.skill_router.endpoint = "http://127.0.0.1:8080"
  config.memory = { ...config.memory, engine: "jev" }
  deps = { directory: worktree, worktree, config, log() {} }
  skill("plan", "Plan relevant implementation work.")
  skill("review", "Review a proposed implementation.")
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(worktree, { recursive: true, force: true })
})

function skill(name: string, description: string): void {
  const directory = join(worktree, ".opencode", "skills", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nPrivate instructions stay local.\n`)
}

function openCodeSource(response: unknown, directory = worktree, role: ExecutionRole = "main"): SkillPermissionSource {
  const client = { app: { agents: async () => response } } as unknown as HookDeps["client"]
  return createOpenCodeSkillPermissionSource({ client, directory }, role)
}

test("core catalog uses injected permissions and denies disabled, absent, or malformed permission data", async () => {
  expect(deps).not.toHaveProperty("client")
  const signal = new AbortController().signal
  const allowed = await availableCandidates(deps, async () => ({ skillEnabled: true, permissions: allowAll }), signal)
  expect(allowed).toEqual([
    { name: "plan", description: "Plan relevant implementation work." },
    { name: "review", description: "Review a proposed implementation." },
  ])

  const deniedSources: SkillPermissionSource[] = [
    async () => null,
    async () => ({ skillEnabled: false, permissions: allowAll }),
    async () => ({ skillEnabled: true, permissions: undefined }),
    async () => ({ skillEnabled: true, permissions: { skill: "allow" } }),
    async () => ({ skillEnabled: true, permissions: [{ permission: "skill", pattern: "*", action: "maybe" }] }),
  ]
  for (const source of deniedSources) {
    expect(await availableCandidates(deps, source, signal)).toEqual([])
  }
})

test("non-SDK permissions observe current config without a vendor client or grant state", async () => {
  const source = createConfigSkillPermissionSource(deps)
  const signal = new AbortController().signal
  expect(deps).not.toHaveProperty("client")
  expect((await availableCandidates(deps, source, signal)).map(candidate => candidate.name)).toEqual(["plan", "review"])
  deps.config.skills.allow = ["review"]
  expect(await source(signal)).toEqual({
    skillEnabled: true,
    permissions: [
      { permission: "skill", pattern: "*", action: "deny" },
      { permission: "skill", pattern: "review", action: "allow" },
    ],
  })
  expect((await availableCandidates(deps, source, signal)).map(candidate => candidate.name)).toEqual(["review"])
  deps.config.skills.allow = []
  expect(await availableCandidates(deps, source, signal)).toEqual([])
  const cancelled = new AbortController()
  cancelled.abort()
  expect(await source(cancelled.signal)).toBeNull()
})

test("config permission adapter does not widen the router catalog beyond sixteen names", async () => {
  deps.config.skills.allow = Array.from({ length: 17 }, (_, index) => `skill-${index}`)
  for (const name of deps.config.skills.allow) skill(name, `Description for ${name}.`)
  expect(await availableCandidates(deps, createConfigSkillPermissionSource(deps), new AbortController().signal)).toEqual([])
})

test("normalized permission rules keep last-match behavior", async () => {
  const signal = new AbortController().signal
  const planDenied = await availableCandidates(deps, async () => ({
    skillEnabled: true,
    permissions: [
      { permission: "skill", pattern: "*", action: "allow" },
      { permission: "skill", pattern: "plan", action: "deny" },
    ],
  }), signal)
  expect(planDenied.map((candidate) => candidate.name)).toEqual(["review"])

  const planAllowed = await availableCandidates(deps, async () => ({
    skillEnabled: true,
    permissions: [
      { permission: "skill", pattern: "*", action: "deny" },
      { permission: "skill", pattern: "plan", action: "allow" },
    ],
  }), signal)
  expect(planAllowed.map((candidate) => candidate.name)).toEqual(["plan"])
})

test("shared permission predicate preserves ordered rules and refuses unsupported or malformed patterns", () => {
  expect(skillPermissionAllowed([
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "plan", action: "deny" },
  ], "plan")).toBe(false)
  expect(skillPermissionAllowed([
    { permission: "skill", pattern: "*", action: "deny" },
    { permission: "skill", pattern: "plan", action: "allow" },
  ], "plan")).toBe(true)
  expect(skillPermissionAllowed([{ permission: "skill", pattern: "[p]lan", action: "allow" }], "plan")).toBe(false)
  expect(skillPermissionAllowed([{ permission: "skill", pattern: "*", action: "maybe" }], "plan")).toBe(false)
  expect(skillPermissionAllowed({ skill: "allow" }, "plan")).toBe(false)
})

test("project catalog refuses protected-name shadows and escaping descriptor metadata", async () => {
  const external = mkdtempSync(join(tmpdir(), "otter-external-skill-"))
  try {
    deps.config.skills.allow = ["deep-interview", "escape"]
    skill("deep-interview", "Untrusted project shadow of a protected workflow.")
    writeFileSync(join(external, "SKILL.md"), "---\nname: escape\ndescription: External metadata\n---\nPrivate body\n")
    const agentsSkills = join(worktree, ".agents", "skills")
    mkdirSync(agentsSkills, { recursive: true })
    symlinkSync(external, join(agentsSkills, "escape"), "dir")

    expect(await availableCandidates(deps, async () => ({ skillEnabled: true, permissions: allowAll }), new AbortController().signal)).toEqual([])
  } finally {
    rmSync(external, { recursive: true, force: true })
  }
})

test("OpenCode adapter forwards the exact directory and AbortSignal to app.agents", async () => {
  const directory = `${worktree}/nested/../unchanged`
  const permissions = [{ permission: "skill", pattern: "plan", action: "allow" }]
  let args: unknown[] = []
  const client = {
    app: {
      agents: async (...received: unknown[]) => {
        args = received
        return { data: [{ name: "main", permission: permissions }] }
      },
    },
  } as unknown as HookDeps["client"]
  const source = createOpenCodeSkillPermissionSource({ client, directory })
  const signal = new AbortController().signal

  expect(await source(signal)).toEqual({ skillEnabled: true, permissions })
  expect(args).toHaveLength(1)
  const query = args[0] as { query: { directory: string }; signal: AbortSignal }
  expect(query.query).toEqual({ directory })
  expect(query.signal).toBe(signal)
})

test("OpenCode query errors and missing main deny; disabled skill tool converts to false", async () => {
  const signal = new AbortController().signal
  for (const response of [
    { error: new Error("host query failed"), data: [{ name: "main", permission: allowAll }] },
    { data: null },
    { data: [{ name: "worker", permission: allowAll }] },
  ]) {
    expect(await openCodeSource(response)(signal)).toBeNull()
  }

  const disabled = await openCodeSource({
    data: [{ name: "main", permission: allowAll, tools: { skill: false } }],
  })(signal)
  expect(disabled).toEqual({ skillEnabled: false, permissions: allowAll })
})

test("OpenCode permission adapter reads the requested role and never falls back for missing or unknown roles", async () => {
  const signal = new AbortController().signal
  const mainPermissions = [{ permission: "skill", pattern: "*", action: "deny" }]
  const workerPermissions = [{ permission: "skill", pattern: "*", action: "allow" }]
  const response = {
    data: [
      { name: "main", permission: mainPermissions },
      { name: "worker", permission: workerPermissions, tools: { skill: true } },
    ],
  }

  const workerSource = openCodeSource(response, worktree, "worker")
  expect(await workerSource(signal)).toEqual({ skillEnabled: true, permissions: workerPermissions })
  expect((await availableCandidates(deps, workerSource, signal)).map((candidate) => candidate.name)).toEqual(["plan", "review"])
  expect(await availableCandidates(deps, openCodeSource(response, worktree, "reviewer"), signal)).toEqual([])
  expect(await openCodeSource(response, worktree, "future-role" as ExecutionRole)(signal)).toBeNull()

  const deniedWorker = openCodeSource({
    data: [
      { name: "main", permission: workerPermissions },
      { name: "worker", permission: mainPermissions, tools: { skill: true } },
    ],
  }, worktree, "worker")
  expect(await availableCandidates(deps, deniedWorker, signal)).toEqual([])
})

test("permission-source exceptions reach router failure handling as unavailable", async () => {
  const failure = new Error("permission source failed")
  const source: SkillPermissionSource = async () => { throw failure }
  const signal = new AbortController().signal
  await expect(availableCandidates(deps, source, signal)).rejects.toThrow("permission source failed")

  const result = await createSkillRouter(deps, source).recommend("source-error", "message", "Investigate")
  expect(result).toMatchObject({ skill: null, reason: "unavailable" })
})

test("a source revocation after inference suppresses the candidate", async () => {
  deps.config.skills.allow = ["plan"]
  let skillEnabled = true
  let sourceCalls = 0
  const source: SkillPermissionSource = async () => {
    sourceCalls++
    return { skillEnabled, permissions: allowAll }
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      skillEnabled = false
      return Response.json({
        answers: { route: { type: "choice", choice: "plan", probabilities: { plan: 0.99, none: 0.01 }, confidence: 0.9 } },
      })
    },
  })
  deps.config.skill_router.endpoint = `http://127.0.0.1:${server.port}`

  const result = await createSkillRouter(deps, source).recommend("source-revoke", "message", "Investigate")
  expect(result).toMatchObject({ skill: null, reason: "candidate_changed" })
  expect(sourceCalls).toBe(2)
})
