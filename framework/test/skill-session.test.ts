import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliTools } from "../src/hosts/cli-tools.ts"
import { chatExecuteMode } from "../src/config.ts"
import type { CliNativeIdentity, CliTransportHandle } from "../src/hosts/cli-transport.ts"
import { createCodexProfile } from "../src/hosts/codex-profile.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionRequest } from "../src/hosts/types.ts"
import { attachAdmission, detachAdmission, holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { pendingSkillPermissionActivityCount } from "../src/skills/activity.ts"
import {
  beginSkillLoaderWitness, bindSkillInvocation, consumeSkillLoaderWitness, finishSkillInvocation,
  finishSkillLoaderWitness, registerSkillLoaderWitness as registerWitnessWithInstructions,
  skillLoaderWitnessCompletion, skillLoaderWitnessRegistered,
  type SkillInvocationContext,
} from "../src/skills/context.ts"
import { NATIVE_PROTOCOL_SHA256 } from "../src/skillopt/dataset.ts"
import { buildNativeEvaluationPrompt, NATIVE_EVALUATION_PROTOCOL_SHA256 } from "../src/skillopt/evaluation.ts"
import { sha256 } from "../src/skillopt/pilot.ts"
import { resolveSkillRoots } from "../src/skills/roots.ts"
import { claimPreparedSkillInvocation, SkillSession } from "../src/skills/session.ts"
import { DEFAULT_SKILL_AUTO, NO_SKILL_TRUST, parseSkillAuto, parseSkillTrust, readSkillTrust, type SkillAutoPolicy, type SkillTrust } from "../src/skills/trust.ts"
import { tempWorktree } from "./guards-helpers.ts"
import { makeSkillOptCanaryFixture } from "./skillopt-canary-fixtures.ts"

const SID = "skill_source_session"
const WITNESS_SID = "skill_witness_session"
const WITNESS_MODEL = "gpt-5.6-sol"
const WITNESS_SKILL_TEXT = "---\nname: llm-wiki\ndescription: Inspect this project\nallowed-tools: [read]\n---\nUse the captured wiki instructions exactly.\r\n"
let cachedWitnessCanary: Readonly<{ taskText: string; binding: Readonly<{
  fixturePackSha256: string; fixtureId: string; fixtureSha256: string; taskSha256: string
  evaluatorPromptSha256: string; evaluatorSystemSha256: string; protocolSha256: string; evaluatorSha256: string
}>; systemInstructions: string
}> | undefined

function witnessCanary() {
  if (cachedWitnessCanary) return cachedWitnessCanary
  const fixture = makeSkillOptCanaryFixture()
  const evaluatorPrompt = buildNativeEvaluationPrompt(fixture.fixture, WITNESS_SKILL_TEXT)
  const systemPrefix = `${WITNESS_SKILL_TEXT}\n\n`
  if (!evaluatorPrompt.system.startsWith(systemPrefix)) throw new Error("Synthetic evaluator prompt has an unexpected skill prefix")
  const systemInstructions = evaluatorPrompt.system.slice(systemPrefix.length)
  const taskText = evaluatorPrompt.user
  cachedWitnessCanary = Object.freeze({
    taskText,
    systemInstructions,
    binding: Object.freeze({
      fixturePackSha256: fixture.packSha256,
      fixtureId: fixture.fixture.id,
      fixtureSha256: fixture.fixtureSha256,
      taskSha256: sha256(taskText),
      evaluatorPromptSha256: evaluatorPrompt.promptSha256,
      evaluatorSystemSha256: sha256(systemInstructions),
      protocolSha256: NATIVE_PROTOCOL_SHA256,
      evaluatorSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    }),
  })
  return cachedWitnessCanary
}

function registerSkillLoaderWitness(context: SkillInvocationContext, binding: ReturnType<typeof witnessCanary>["binding"]) {
  return registerWitnessWithInstructions(context, binding, witnessCanary().systemInstructions)
}
const signal = () => new AbortController().signal
let fixture: ReturnType<typeof tempWorktree>
let runtime: ReturnType<typeof createCliRuntime>
let store: SessionStore
let sessions: SkillSession[]
let witnessSessionSequence = 0
let choices: string[]
let choose: (title: string, values: readonly string[], signal: AbortSignal) => Promise<number | undefined>

function git(...args: string[]): string { return gitIn(fixture.worktree, ...args) }
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
async function source(foreground = true, trust?: SkillTrust): Promise<SkillSession> {
  const roots = await resolveSkillRoots({ projectRoot: fixture.worktree })
  const session = await SkillSession.create({
    roots, store, ...(trust ? { trust } : {}),
    ...(foreground ? { terminal: { stdinIsTTY: true, stderrIsTTY: true, choose: async (title: string, values: readonly string[], abort: AbortSignal) => {
      choices.push(title)
      return choose(title, values, abort)
    } } } : {}),
  }, signal())
  sessions.push(session)
  return session
}

async function witnessFixture(options: { role?: "main" | "worker"; priorPreparation?: boolean; identityAfter?: CliNativeIdentity; omitPolicyModel?: boolean } = {}) {
  put("llm-wiki", "Use the captured wiki instructions exactly.\r\n")
  if (git("status", "--porcelain")) commit()
  const roots = await resolveSkillRoots({ projectRoot: fixture.worktree })
  const witnessRuntime = createCliRuntime({ worktree: fixture.worktree, engine: "codex", model: WITNESS_MODEL })
  const witnessSessionID = `${WITNESS_SID}_${++witnessSessionSequence}`
  const witnessStore = attachAdmission(witnessRuntime, witnessSessionID, { engine: "codex", model: WITNESS_MODEL })
  const terminal = {
    stdinIsTTY: true,
    stderrIsTTY: true,
    choose: async (title: string, values: readonly string[], abort: AbortSignal) => {
      choices.push(title)
      return choose(title, values, abort)
    },
  }
  if (options.priorPreparation) {
    const prior = await SkillSession.create({ roots, store: witnessStore, terminal, trust: NO_SKILL_TRUST }, signal())
    sessions.push(prior)
    await prior.prepare("llm-wiki", signal())
    prior.close()
  }
  const session = await SkillSession.create({ roots, store: witnessStore, terminal, trust: NO_SKILL_TRUST }, signal())
  sessions.push(session)
  const prepared = await session.prepare("llm-wiki", signal())
  const canary = witnessCanary()
  const role = options.role ?? "main"
  const policyConfig = options.omitPolicyModel
    ? { ...witnessRuntime.config, models: { ...witnessRuntime.config.models, main: undefined } }
    : witnessRuntime.config
  const nativeContext = witnessRuntime.policy.resolve(role).nativeContext
  const policy = createExecutionPolicy(policyConfig, {
    planningOnlyMain: true,
    chatExecuteMain: chatExecuteMode(witnessRuntime.config) !== "plan",
    ...(nativeContext ? { nativeContext } : {}),
    skillLoaderCanaryInstructions: canary.systemInstructions,
  })
  const scope = {
    executionID: "witness-execution",
    supervisorSessionID: witnessSessionID,
    taskID: "witness-task",
    attemptID: "witness-attempt",
    generation: 1,
    role,
    title: "Loader witness fixture",
    cwd: fixture.worktree,
    text: canary.taskText,
    deadlineAt: Date.now() + 60_000,
    policy: policy.resolve(role),
  }
  const bound = bindSkillInvocation(prepared, scope, policy)
  const request: ExecutionRequest = { ...scope, skillContext: bound.context, handlers: bound.handlers }
  const codexProfile = createCodexProfile(WITNESS_MODEL)
  const identity: CliNativeIdentity = Object.freeze({
    engine: "codex",
    requestedModel: WITNESS_MODEL,
    runtimeIdentity: Object.freeze({ version: "0.163.0", executableSha256: "a".repeat(64) }),
    profileIdentity: Object.freeze({ id: "codex-restricted-read.v1", sha256: codexProfile.catalogHash }),
  })
  const calls = { identity: 0, run: 0 }
  const transport: CliTransportHandle = {
    async run() { calls.run++; throw new Error("mock witness fixture must not dispatch native inference") },
    async requestCancel() { return { requested: false, acknowledged: false, terminal: true, quiescent: true, evidence: "mock fixture" } },
    async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "mock transport fixture only" } },
    async inspectIdentity() {
      calls.identity++
      return calls.identity === 1 ? identity : options.identityAfter ?? identity
    },
  }
  const instructions = bound.instructions
  const prompt = `Canary prefix: 한글🦦\n${instructions}\n${canary.systemInstructions}\n${canary.taskText}`
  request.text = prompt
  return { session, store: witnessStore, bound, request, policy, instructions, prompt, identity, transport, calls, codexProfile, canary }
}

beforeEach(() => {
  fixture = tempWorktree()
  fixture.worktree = realpathSync.native(fixture.worktree)
  git("init", "--quiet")
  runtime = createCliRuntime({ worktree: fixture.worktree, engine: "local", model: "fixture/model" })
  store = attachAdmission(runtime, SID, { engine: "local", model: "fixture/model" })
  sessions = []
  witnessSessionSequence = 0
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

test("user-config trust by name or folder skips the consent prompt and survives content changes", async () => {
  const directory = put("custom")
  put("other")
  const byName = parseSkillTrust(["custom"]) as SkillTrust
  let session = await source(true, byName)
  expect((await session.catalog(signal())).entries.find(entry => entry.descriptor.name === "custom")?.trusted).toBe(true)
  claimPreparedSkillInvocation(await session.prepare("custom", signal()))
  expect(choices).toEqual([])
  expect(session.listGrants()).toEqual([expect.objectContaining({ name: "custom", trusted: true })])
  // Changed content is still trusted (trust is by name), and the grant binds to the new bytes.
  writeFileSync(join(directory, "SKILL.md"), "---\nname: custom\ndescription: Inspect this project\n---\nChanged.\n")
  const changed = claimPreparedSkillInvocation(await session.prepare("custom", signal()))
  expect(changed.text).toContain("Changed.")
  expect(choices).toEqual([])
  // An untrusted sibling still asks.
  await session.prepare("other", signal())
  expect(choices).toHaveLength(1)

  session.close()
  choices = []
  session = await source(true, parseSkillTrust([join(fixture.worktree, ".agents", "skills")]) as SkillTrust)
  await session.prepare("other", signal())
  expect(choices).toEqual([])
  // Without trust the prompt is back.
  session.close()
  session = await source(true, NO_SKILL_TRUST)
  await session.prepare("other", signal())
  expect(choices).toHaveLength(1)
})

test("skill trust parses only names and absolute/~ folders and is read from the user config alone", () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-trust-home-")))
  try {
    mkdirSync(join(home, ".codex", "skills"), { recursive: true })
    const parsed = parseSkillTrust(["code-review", "~/.codex/skills", "/opt/skills"], home) as SkillTrust
    expect([...parsed.names]).toEqual(["code-review"])
    expect(parsed.folders).toEqual([join(home, ".codex", "skills"), "/opt/skills"])
    expect(parseSkillTrust("code-review", home)).toContain("must be an array")
    expect(parseSkillTrust(["relative/skills"], home)).toContain("neither a skill name")
    expect(parseSkillTrust([1], home)).toContain("must be an array")
    expect(parseSkillTrust(undefined, home)).toBe(NO_SKILL_TRUST)

    const config = join(home, "otter.jsonc")
    expect(readSkillTrust(config, home)).toEqual({ trust: NO_SKILL_TRUST, auto: DEFAULT_SKILL_AUTO, source: config })
    writeFileSync(config, `{\n  // trusted by the operator\n  "skill_trust": ["code-review"],\n}\n`)
    expect([...readSkillTrust(config, home).trust.names]).toEqual(["code-review"])
    writeFileSync(config, `{ "skill_trust": ["bad path"] }`)
    const invalid = readSkillTrust(config, home)
    expect(invalid.trust).toBe(NO_SKILL_TRUST)
    expect(invalid.problem).toContain("neither a skill name")
    writeFileSync(config, "{ not jsonc")
    expect(readSkillTrust(config, home).problem).toContain("not valid JSONC")
    expect(readSkillTrust(config, home).auto.mode).toBe("off")
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("skill_auto parses mode/include/exclude from the user config and fails closed to off", () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-auto-home-")))
  try {
    expect(parseSkillAuto(undefined)).toBe(DEFAULT_SKILL_AUTO)
    expect(DEFAULT_SKILL_AUTO.mode).toBe("auto")
    expect(parseSkillAuto({ mode: "shadow" })).toContain("mode must be off or auto")
    const parsed = parseSkillAuto({ mode: "auto", include: ["code-review"], exclude: ["orca-cli"] }) as SkillAutoPolicy
    expect(parsed.mode).toBe("auto")
    expect([...parsed.include]).toEqual(["code-review"])
    expect([...parsed.exclude]).toEqual(["orca-cli"])
    expect(parseSkillAuto({ mode: "on" })).toContain("mode must be")
    expect(parseSkillAuto({ include: ["~/x"] })).toContain("include must be")
    expect(parseSkillAuto({ modes: "auto" })).toContain("unknown key")
    expect(parseSkillAuto(["auto"])).toContain("must be an object")

    const config = join(home, "otter.jsonc")
    writeFileSync(config, `{ "skill_trust": ["a"], "skill_auto": { "mode": "auto", "exclude": ["b"] } }`)
    const read = readSkillTrust(config, home)
    expect(read.problem).toBeUndefined()
    expect(read.auto.mode).toBe("auto")
    expect([...read.trust.names]).toEqual(["a"])
    // An invalid skill_auto disables selection but keeps valid trust; the problem is reported.
    writeFileSync(config, `{ "skill_trust": ["a"], "skill_auto": { "mode": "yes" } }`)
    const invalid = readSkillTrust(config, home)
    expect(invalid.auto.mode).toBe("off")
    expect([...invalid.trust.names]).toEqual(["a"])
    expect(invalid.problem).toContain("skill_auto.mode")
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("auto candidates are consent-free, policy-filtered and size-bounded; consent never refuses instead of prompting", async () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-auto-cands-")))
  try {
    const homeSkill = (base: string, name: string, description: string) => {
      const directory = join(home, base, name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`)
    }
    put("common")
    put("large", "x".repeat(4000))
    commit()
    put("uncommitted")
    homeSkill(".agents/skills", "native-home", "Native home skill")
    homeSkill(".agents/skills", "untrusted-home", "Not trusted")
    homeSkill(".codex/skills", "imported", "Codex convention skill")
    const trust = parseSkillTrust(["native-home", "imported"], home) as SkillTrust
    const roots = await resolveSkillRoots({ projectRoot: fixture.worktree, homeDirectory: home })
    const session = await SkillSession.create({
      roots, store, trust,
      terminal: { stdinIsTTY: true, stderrIsTTY: true, choose: async (title: string) => { choices.push(title); return 0 } },
    }, signal())
    sessions.push(session)
    const names = async (policy: SkillAutoPolicy, max = 1000) => (await session.autoCandidates(policy, max, signal())).map(c => c.name)

    expect(await names(DEFAULT_SKILL_AUTO)).toEqual(["common", "native-home"])
    expect(await names(DEFAULT_SKILL_AUTO, 10_000)).toEqual(["common", "large", "native-home"])
    expect(await names({ ...DEFAULT_SKILL_AUTO, include: new Set(["imported"]) })).toEqual(["common", "imported", "native-home"])
    expect(await names({ ...DEFAULT_SKILL_AUTO, exclude: new Set(["common"]) })).toEqual(["native-home"])
    expect(await names({ ...DEFAULT_SKILL_AUTO, mode: "off" })).toEqual([])
    // A session grant from an explicit prompt does not make a skill automatically eligible.
    await session.prepare("uncommitted", signal())
    expect(choices).toHaveLength(1)
    expect(await names(DEFAULT_SKILL_AUTO)).not.toContain("uncommitted")
    expect((await session.autoCandidates(DEFAULT_SKILL_AUTO, 1000, signal()))[0]).toEqual({ name: "common", description: "Inspect this project", bytes: expect.any(Number) })

    // consent "never": authorized skills prepare silently; anything needing a prompt refuses without one.
    choices = []
    claimPreparedSkillInvocation(await session.prepare("common", signal(), { consent: "never" }))
    claimPreparedSkillInvocation(await session.prepare("native-home", signal(), { consent: "never" }))
    await expect(session.prepare("untrusted-home", signal(), { consent: "never" })).rejects.toThrow("never prompts")
    expect(choices).toEqual([])
    expect(session.listGrants().map(grant => grant.name)).not.toContain("untrusted-home")
    // An explicit session grant (prompted earlier) still does not authorize automatic use.
    await expect(session.prepare("uncommitted", signal(), { consent: "never" })).rejects.toThrow("not usable without consent")
    // A declared allowed-tools scope pre-approves; it no longer excludes a skill from automatic use.
    expect(await names(DEFAULT_SKILL_AUTO, 1000)).toEqual(["common", "native-home"])
    writeFileSync(join(home, ".agents/skills", "native-home", "SKILL.md"), "---\nname: native-home\ndescription: Native home skill\nallowed-tools: [read]\n---\nBody.\n")
    expect(await names(DEFAULT_SKILL_AUTO, 1000)).toContain("native-home")
    claimPreparedSkillInvocation(await session.prepare("native-home", signal(), { consent: "never" }))
    // disable-model-invocation keeps a trusted skill out of automatic use, while explicit prepare still works.
    writeFileSync(join(home, ".agents/skills", "native-home", "SKILL.md"), "---\nname: native-home\ndescription: Native home skill\ndisable-model-invocation: true\n---\nBody.\n")
    expect(await names(DEFAULT_SKILL_AUTO)).not.toContain("native-home")
    await expect(session.prepare("native-home", signal(), { consent: "never" })).rejects.toThrow("not usable without consent")
    expect(choices).toEqual([])
    claimPreparedSkillInvocation(await session.prepare("native-home", signal()))
    expect(choices).toEqual([])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("a project skill shadowing a name-trusted home skill is never automatic, while folder trust still applies", async () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-auto-shadow-")))
  try {
    const homeDirectory = join(home, ".agents", "skills", "orca-cli")
    mkdirSync(homeDirectory, { recursive: true })
    writeFileSync(join(homeDirectory, "SKILL.md"), "---\nname: orca-cli\ndescription: Home skill\n---\nHOME\n")
    const roots = await resolveSkillRoots({ projectRoot: fixture.worktree, homeDirectory: home })
    const create = async (trust: SkillTrust) => {
      const session = await SkillSession.create({ roots, store, trust }, signal())
      sessions.push(session)
      return session
    }
    let session = await create(parseSkillTrust(["orca-cli"], home) as SkillTrust)
    expect((await session.autoCandidates(DEFAULT_SKILL_AUTO, 1000, signal())).map(c => c.name)).toEqual(["orca-cli"])
    // A cloned repository adds an untracked project skill with the trusted name: project wins discovery.
    put("orca-cli", "REPO BYTES\n")
    expect(await session.autoCandidates(DEFAULT_SKILL_AUTO, 1000, signal())).toEqual([])
    await expect(session.prepare("orca-cli", signal(), { consent: "never" })).rejects.toThrow("not usable without consent")
    // Explicit name trust is unchanged for explicit invocation.
    expect(claimPreparedSkillInvocation(await session.prepare("orca-cli", signal())).text).toContain("REPO BYTES")
    // Folder trust that contains the project skill directory is an operator decision about that path.
    session.close()
    session = await create(parseSkillTrust([join(fixture.worktree, ".agents", "skills")], home) as SkillTrust)
    expect((await session.autoCandidates(DEFAULT_SKILL_AUTO, 1000, signal())).map(c => c.name)).toEqual(["orca-cli"])
  } finally { rmSync(home, { recursive: true, force: true }) }
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
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-skill-pull-")))
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

test("native witness receipt binds captured bytes and the UTF-8 prompt span (mock transport evidence only)", async () => {
  const f = await witnessFixture()
  expect(f.request.policy).toBe(f.policy.resolve("main"))
  expect(f.request.policy.system).toContain(f.canary.systemInstructions)
  const observation = registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  expect(Object.isFrozen(observation)).toBe(true)
  expect(skillLoaderWitnessCompletion(f.request, observation)).toBeUndefined()
  expect(await beginSkillLoaderWitness(f.request, {
    prompt: f.prompt, engine: "codex", model: WITNESS_MODEL,
    codexProfileSha256: f.codexProfile.catalogHash, transport: f.transport,
  })).toBe(observation)
  await finishSkillLoaderWitness(f.request, observation, {
    status: "completed", quiescent: true, responseKind: "final",
    responseText: "synthetic mock response",
    requestText: f.request.text,
    reconciliation: await f.transport.reconcile(),
  })
  const completedReceipt = skillLoaderWitnessCompletion(f.request, observation)
  expect(completedReceipt).toBeDefined()
  expect(skillLoaderWitnessCompletion(f.request, observation)).toBe(completedReceipt)
  finishSkillInvocation(f.bound.context)
  const consume = consumeSkillLoaderWitness(observation)
  const replay = expect(consumeSkillLoaderWitness(observation)).rejects.toThrow("already consumed")
  const receipt = await consume
  expect(receipt).toMatchObject({
    version: "native-v1",
    loaderDelivery: "observed",
    behavioralCanary: "not-evaluated",
    capture: { identity: "project:.agents/skills/llm-wiki", source: "project" },
    native: { engine: "codex", requestedModel: WITNESS_MODEL, status: "completed", quiescent: true },
  })
  expect(receipt.instructions.span.startByte).toBe(Buffer.byteLength("Canary prefix: 한글🦦\n", "utf8"))
  expect(receipt.instructions.span.endByte - receipt.instructions.span.startByte).toBe(Buffer.byteLength(f.instructions, "utf8"))
  expect(receipt.instructions.span.sha256).toBe(receipt.capture.skillFileSha256)
  expect(receipt.fileIdentity.beforeSha256).toBe(receipt.fileIdentity.afterSha256)
  expect(receipt.canary).toEqual(f.canary.binding)
  expect(receipt.evaluatorSystemInstructions).toBe(f.canary.systemInstructions)
  expect(receipt.instructions.evaluatorSystem.utf8Sha256).toBe(f.canary.binding.evaluatorSystemSha256)
  expect(completedReceipt).toBe(receipt)
  expect(receipt.requestTextSha256).toBe(sha256(f.request.text))
  expect(receipt.requestTextSha256).not.toBe(receipt.canary.taskSha256)
  expect(receipt.response).toEqual({ sha256: sha256("synthetic mock response"), bytes: Buffer.byteLength("synthetic mock response", "utf8") })
  expect(f.calls).toEqual({ identity: 2, run: 0 })
  await replay
})

test("witness registration rejects copied contexts, audit-like data, duplicate observers and wrong roles", async () => {
  const f = await witnessFixture()
  expect(() => registerSkillLoaderWitness(f.bound.context, {
    ...f.canary.binding, taskSha256: "0".repeat(64),
  })).toThrow("canary task binding")
  const observation = registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  expect(() => registerSkillLoaderWitness({ ...f.bound.context } as unknown as SkillInvocationContext, f.canary.binding)).toThrow("authentic skill context")
  expect(() => registerSkillLoaderWitness({ ...f.bound.context, capture: undefined } as unknown as SkillInvocationContext, f.canary.binding)).toThrow("authentic skill context")
  expect(() => registerSkillLoaderWitness(f.bound.context, f.canary.binding)).toThrow("authentic skill context")
  await expect(consumeSkillLoaderWitness({ ...observation } as unknown as typeof observation)).rejects.toThrow("copied")

  const worker = await witnessFixture({ role: "worker" })
  expect(() => registerSkillLoaderWitness(worker.bound.context, worker.canary.binding)).toThrow("tool-free main request")
})

test("a restored-in-memory skill session cannot register a fresh loader witness", async () => {
  const f = await witnessFixture({ priorPreparation: true })
  expect(() => registerSkillLoaderWitness(f.bound.context, f.canary.binding)).toThrow("first skill preparation")
})

test("witness refuses evaluator instructions before captured skill instructions", async () => {
  const f = await witnessFixture()
  registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  await expect(beginSkillLoaderWitness(f.request, {
    prompt: `${f.canary.systemInstructions}\n\n${f.instructions}\n\n${f.canary.taskText}`,
    engine: "codex", model: WITNESS_MODEL,
    codexProfileSha256: f.codexProfile.catalogHash, transport: f.transport,
  })).rejects.toThrow("must follow the captured skill span")
  expect(f.calls.run).toBe(0)
})

test("witness refuses a host route that differs from the owned session profile", async () => {
  const f = await witnessFixture()
  registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  await expect(beginSkillLoaderWitness(f.request, {
    prompt: f.prompt, engine: "claude", model: "claude-fixture", transport: f.transport,
  })).rejects.toThrow("native route")
  expect(f.calls.identity).toBe(0)
  expect(f.calls.run).toBe(0)
})

test("witness refuses an absent policy model before probing native identity", async () => {
  const f = await witnessFixture({ omitPolicyModel: true })
  registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  await expect(beginSkillLoaderWitness(f.request, {
    prompt: f.prompt, engine: "codex", model: WITNESS_MODEL,
    transport: f.transport, codexProfileSha256: f.codexProfile.catalogHash,
  })).rejects.toThrow("native route")
  expect(f.calls).toEqual({ identity: 0, run: 0 })
})

test("witness begin refuses scope drift, local engines, and source changes before any native dispatch", async () => {
  const f = await witnessFixture()
  registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  const input = {
    prompt: f.prompt, engine: "codex" as const, model: WITNESS_MODEL,
    codexProfileSha256: f.codexProfile.catalogHash, transport: f.transport,
  }
  await expect(beginSkillLoaderWitness({ ...f.request, executionID: "wrong-execution" }, input)).rejects.toThrow("another request")
  writeFileSync(join(fixture.worktree, ".agents", "skills", "llm-wiki", "SKILL.md"),
    "---\nname: llm-wiki\ndescription: Inspect this project\nallowed-tools: [read]\n---\nChanged after the real capture.\n")
  await expect(beginSkillLoaderWitness(f.request, input)).rejects.toThrow("changed")
  expect(f.calls.run).toBe(0)

  const local = await witnessFixture()
  registerSkillLoaderWitness(local.bound.context, local.canary.binding)
  await expect(beginSkillLoaderWitness(local.request, {
    prompt: local.prompt, engine: "local", model: WITNESS_MODEL,
    transport: local.transport,
  })).rejects.toThrow("Local engines")
  expect(local.calls.identity).toBe(0)
  expect(local.calls.run).toBe(0)
})

test("admission revocation invalidates an already registered witness", async () => {
  const f = await witnessFixture()
  registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  holdAdmission(fixture.worktree, f.store.sessionID, "witness-revoked")
  expect(() => skillLoaderWitnessRegistered(f.request)).toThrow("expired")
})

test("source revision revocation invalidates a registered loader observation", async () => {
  const f = await witnessFixture()
  const observation = registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  f.session.revoke("llm-wiki")
  expect(() => skillLoaderWitnessRegistered(f.request)).toThrow()
  await expect(consumeSkillLoaderWitness(observation)).rejects.toThrow("failed closed")
})

test("failed, nonquiescent, and identity-drift native results never yield a receipt", async () => {
  const failed = await witnessFixture()
  const failedObservation = registerSkillLoaderWitness(failed.bound.context, failed.canary.binding)
  await beginSkillLoaderWitness(failed.request, {
    prompt: failed.prompt, engine: "codex", model: WITNESS_MODEL,
    codexProfileSha256: failed.codexProfile.catalogHash, transport: failed.transport,
  })
  await expect(finishSkillLoaderWitness(failed.request, failedObservation, {
    status: "failed", quiescent: true, responseKind: "invalid",
    reconciliation: await failed.transport.reconcile(),
  })).rejects.toThrow("not witness-eligible")
  expect(skillLoaderWitnessCompletion(failed.request, failedObservation)).toBeUndefined()
  await expect(consumeSkillLoaderWitness(failedObservation)).rejects.toThrow("failed closed")

  const wrongRequest = await witnessFixture()
  const wrongRequestObservation = registerSkillLoaderWitness(wrongRequest.bound.context, wrongRequest.canary.binding)
  await beginSkillLoaderWitness(wrongRequest.request, {
    prompt: wrongRequest.prompt, engine: "codex", model: WITNESS_MODEL,
    codexProfileSha256: wrongRequest.codexProfile.catalogHash, transport: wrongRequest.transport,
  })
  await expect(finishSkillLoaderWitness(wrongRequest.request, wrongRequestObservation, {
    status: "completed", quiescent: true, responseKind: "final",
    responseText: "synthetic mock response",
    requestText: `${wrongRequest.request.text} altered`,
    reconciliation: await wrongRequest.transport.reconcile(),
  })).rejects.toThrow("request text is absent, altered")
  expect(skillLoaderWitnessCompletion(wrongRequest.request, wrongRequestObservation)).toBeUndefined()
  await expect(consumeSkillLoaderWitness(wrongRequestObservation)).rejects.toThrow("failed closed")

  const pending = await witnessFixture()
  const pendingObservation = registerSkillLoaderWitness(pending.bound.context, pending.canary.binding)
  await beginSkillLoaderWitness(pending.request, {
    prompt: pending.prompt, engine: "codex", model: WITNESS_MODEL,
    codexProfileSha256: pending.codexProfile.catalogHash, transport: pending.transport,
  })
  await expect(finishSkillLoaderWitness(pending.request, pendingObservation, {
    status: "completed", quiescent: false, responseKind: "final",
    responseText: "mock final response",
    requestText: pending.request.text,
    reconciliation: { outcome: "unknown", quiescent: false, evidence: "mock fixture remains unresolved" },
  })).rejects.toThrow("not witness-eligible")
  await expect(consumeSkillLoaderWitness(pendingObservation)).rejects.toThrow("failed closed")

  const drifted = await witnessFixture({ identityAfter: Object.freeze({
    ...pending.identity,
    runtimeIdentity: Object.freeze({ ...pending.identity.runtimeIdentity, executableSha256: "b".repeat(64) }),
  }) })
  const driftedObservation = registerSkillLoaderWitness(drifted.bound.context, drifted.canary.binding)
  await beginSkillLoaderWitness(drifted.request, {
    prompt: drifted.prompt, engine: "codex", model: WITNESS_MODEL,
    codexProfileSha256: drifted.codexProfile.catalogHash, transport: drifted.transport,
  })
  await expect(finishSkillLoaderWitness(drifted.request, driftedObservation, {
    status: "completed", quiescent: true, responseKind: "final",
    responseText: "mock final response",
    requestText: drifted.request.text,
    reconciliation: await drifted.transport.reconcile(),
  })).rejects.toThrow("native runtime identity verification failed")
  await expect(consumeSkillLoaderWitness(driftedObservation)).rejects.toThrow("failed closed")
})

test("duplicate native witness dispatch is refused before a second identity probe", async () => {
  const f = await witnessFixture()
  const observation = registerSkillLoaderWitness(f.bound.context, f.canary.binding)
  const input = {
    prompt: f.prompt, engine: "codex" as const, model: WITNESS_MODEL,
    codexProfileSha256: f.codexProfile.catalogHash, transport: f.transport,
  }
  await beginSkillLoaderWitness(f.request, input)
  await expect(beginSkillLoaderWitness(f.request, input)).rejects.toThrow("cannot be replayed or dispatched twice")
  expect(f.calls).toEqual({ identity: 1, run: 0 })
  await expect(consumeSkillLoaderWitness(observation)).rejects.toThrow("failed closed")
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
