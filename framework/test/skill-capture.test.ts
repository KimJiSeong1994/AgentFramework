import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  authenticSkillClassification,
  captureSkill,
  isAuthenticCommonSkillCapture,
  isAuthenticSkillCapture,
  readCapturedFile,
  readCapturedSkill,
  revalidateSkillCapture,
} from "../src/skills/capture.ts"
import { discoverSkills, PROTECTED_WORKFLOWS, resolveSkillRoots } from "../src/skills/roots.ts"
import type { SkillDescriptor, SkillRoots } from "../src/skills/types.ts"

let sandbox: string
let project: string
let home: string
let roots: SkillRoots
let testHome: string
let savedEnvironment: Record<string, string | undefined>

const BASE = ".agents/skills"
const REAL_GIT = Bun.which("git")!

/**
 * Install a real `git` shim ahead of PATH. It is a genuine barrier: the Nth snapshot's `ls-tree` is held until a real
 * git/file mutation has completed, then the unmodified git binary runs. "once" races only the first capture attempt;
 * "always" races every later snapshot. No timers are involved.
 */
function installRaceGit(mutation: string, mode: "once" | "always"): { mutations(): number; restore(): void } {
  const bin = join(sandbox, "race-bin")
  const state = join(sandbox, "race-state")
  mkdirSync(bin, { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(join(bin, "git"), `#!/bin/sh
case " $* " in *" ls-tree "*)
  if [ -n "$LCA_RACE_DIR" ]; then
    n=$(cat "$LCA_RACE_DIR/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$LCA_RACE_DIR/n"
    m=$(cat "$LCA_RACE_DIR/m" 2>/dev/null || echo 0)
    if [ "$n" -ge 2 ] && { [ "$LCA_RACE_MODE" = always ] || [ "$m" -lt 1 ]; }; then
      m=$((m+1)); echo $m > "$LCA_RACE_DIR/m"
      LCA_RACE_N=$m env -u LCA_RACE_DIR sh -c "$LCA_RACE_MUTATION"
    fi
  fi;;
esac
exec "$LCA_REAL_GIT" "$@"
`, { mode: 0o755 })
  const saved = { PATH: process.env.PATH }
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.LCA_REAL_GIT = REAL_GIT
  process.env.LCA_RACE_DIR = state
  process.env.LCA_RACE_MODE = mode
  process.env.LCA_RACE_MUTATION = mutation
  return {
    mutations: () => existsSync(join(state, "m")) ? Number(readFileSync(join(state, "m"), "utf8").trim()) : 0,
    restore() {
      process.env.PATH = saved.PATH
      for (const key of ["LCA_REAL_GIT", "LCA_RACE_DIR", "LCA_RACE_MODE", "LCA_RACE_MUTATION"]) delete process.env[key]
    },
  }
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: testHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(sandbox, "global-git-config"),
      GIT_AUTHOR_NAME: "Capture Fixture",
      GIT_AUTHOR_EMAIL: "capture@example.invalid",
      GIT_COMMITTER_NAME: "Capture Fixture",
      GIT_COMMITTER_EMAIL: "capture@example.invalid",
    },
    stdio: "pipe",
  }).toString("utf8").trim()
}

function initRepo(): void {
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(testHome, { recursive: true })
  git(project, "init", "--quiet")
  git(project, "config", "user.name", "Capture Fixture")
  git(project, "config", "user.email", "capture@example.invalid")
  git(project, "config", "core.filemode", "true")
  git(project, "config", "core.autocrlf", "false")
  git(project, "config", "core.eol", "lf")
}

function skillDirectory(name: string, base = BASE, root = project): string {
  const directory = join(root, base, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

function writeSkill(name: string, options: { base?: string; root?: string; body?: string; allowedTools?: string } = {}): string {
  const directory = skillDirectory(name, options.base, options.root)
  const allowed = options.allowedTools === undefined ? "" : `allowed-tools: ${options.allowedTools}\n`
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Descriptor for ${name}.\n${allowed}---\n\n${options.body ?? `# ${name}\n`}`)
  return directory
}

function commitAll(message = "fixture") {
  git(project, "add", "-A")
  git(project, "commit", "--quiet", "-m", message)
}

async function findDescriptor(name: string, from = roots): Promise<SkillDescriptor> {
  const found = (await discoverSkills(from)).descriptors.find((item) => item.name === name)
  if (!found) throw new Error(`Missing descriptor: ${name}`)
  return found
}

beforeEach(async () => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "lca-skill-capture-")))
  project = join(sandbox, "project")
  home = join(sandbox, "user-home")
  testHome = join(sandbox, "git-home")
  savedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === "HOME" || key.startsWith("GIT_")))
  for (const key of Object.keys(process.env)) if (key === "HOME" || key.startsWith("GIT_")) delete process.env[key]
  process.env.HOME = testHome
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  const globalConfig = join(sandbox, "global-git-config")
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  writeFileSync(globalConfig, "")
  initRepo()
  roots = await resolveSkillRoots({ projectRoot: project, homeDirectory: home })
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (key === "HOME" || key.startsWith("GIT_")) delete process.env[key]
  for (const [key, value] of Object.entries(savedEnvironment)) if (value !== undefined) process.env[key] = value
})

describe("skill discovery", () => {
  test("discovers every valid descriptor, reports same-tier ambiguity, and applies project priority", async () => {
    for (let index = 0; index < 18; index++) writeSkill(`many-${String(index).padStart(2, "0")}`)
    writeSkill("winner")
    writeSkill("project-opencode", { base: ".opencode/skills" })
    writeSkill("winner", { root: home, base: ".claude/skills" })
    writeSkill("project-ambiguous", { base: ".opencode/skills" })
    writeSkill("project-ambiguous", { base: ".agents/skills" })
    writeSkill("project-ambiguous", { root: home, base: ".agents/skills" })
    writeSkill("home-ambiguous", { root: home, base: ".agents/skills" })
    writeSkill("home-ambiguous", { root: home, base: ".config/opencode/skills" })
    writeSkill("home-agents", { root: home, base: ".agents/skills" })
    writeSkill("home-claude", { root: home, base: ".claude/skills" })
    writeSkill("home-opencode", { root: home, base: ".config/opencode/skills" })
    for (const workflow of PROTECTED_WORKFLOWS) writeSkill(workflow.name)

    const result = await discoverSkills(roots)
    const locals = result.descriptors.filter((item) => item.kind === "skill")
    expect(locals.filter((item) => item.source === "project")).toHaveLength(20)
    expect(locals.filter((item) => item.source === "home").map((item) => item.name).sort()).toEqual([
      "home-agents", "home-claude", "home-opencode",
    ])
    expect(result.descriptors.find((item) => item.name === "winner")?.identity).toBe("project:.agents/skills/winner")
    expect(result.descriptors.find((item) => item.name === "project-opencode")?.identity).toBe("project:.opencode/skills/project-opencode")
    for (const workflow of PROTECTED_WORKFLOWS) {
      expect(result.descriptors.find((item) => item.name === workflow.name)).toEqual(workflow)
      expect(result.refusals.some((item) => item.name === workflow.name && item.reason === "protected-name")).toBe(true)
    }
    expect(result.descriptors.some((item) => item.name === "project-ambiguous" || item.name === "home-ambiguous")).toBe(false)
    expect(result.refusals.some((item) => item.name === "project-ambiguous" && item.source === "project" && item.reason === "ambiguous")).toBe(true)
    expect(result.refusals.some((item) => item.name === "home-ambiguous" && item.source === "home" && item.reason === "ambiguous")).toBe(true)
  })

  test("reads GJC roots: native .gjc skills, Codex/Claude import roots, and symlinked duplicates as one skill", async () => {
    writeSkill("gjc-project", { base: ".gjc/skills" })
    writeSkill("gjc-user", { root: home, base: ".gjc/agent/skills" })
    writeSkill("gjc-legacy", { root: home, base: ".gjc/skills" })
    writeSkill("codex-only", { root: home, base: ".codex/skills" })
    writeSkill("project-codex", { base: ".codex/skills" })
    writeSkill("project-claude", { base: ".claude/skills" })
    // Native wins over import: the Codex copy fills nothing when a native root has the name.
    writeSkill("shared", { root: home, base: ".agents/skills" })
    writeSkill("shared", { root: home, base: ".codex/skills" })
    // ~/.claude/skills/<n> -> ../../.agents/skills/<n> is the same directory, not an ambiguity.
    writeSkill("linked", { root: home, base: ".agents/skills" })
    mkdirSync(join(home, ".claude/skills"), { recursive: true })
    symlinkSync("../../.agents/skills/linked", join(home, ".claude/skills/linked"))
    // Two distinct native directories with one name stay ambiguous.
    writeSkill("twice", { root: home, base: ".agents/skills" })
    writeSkill("twice", { root: home, base: ".gjc/agent/skills" })
    // Codex internals and copies of builtin workflows never become skills.
    mkdirSync(join(home, ".codex/skills/.system"), { recursive: true })
    writeSkill("ralplan", { root: home, base: ".codex/skills" })

    const result = await discoverSkills(roots)
    const identity = (name: string) => result.descriptors.find((item) => item.name === name)?.identity
    expect(identity("gjc-project")).toBe("project:.gjc/skills/gjc-project")
    expect(identity("gjc-user")).toBe("home:.gjc/agent/skills/gjc-user")
    expect(identity("gjc-legacy")).toBe("home:.gjc/skills/gjc-legacy")
    expect(identity("codex-only")).toBe("home:.codex/skills/codex-only")
    expect(identity("project-codex")).toBe("project:.codex/skills/project-codex")
    expect(identity("project-claude")).toBe("project:.claude/skills/project-claude")
    expect(identity("shared")).toBe("home:.agents/skills/shared")
    expect(identity("linked")).toBe("home:.agents/skills/linked")
    expect(identity("twice")).toBeUndefined()
    expect(result.refusals.some((item) => item.name === "twice" && item.reason === "ambiguous")).toBe(true)
    expect(result.refusals.some((item) => item.name === "shared" || item.name === "linked")).toBe(false)
    expect(result.refusals.some((item) => item.name === ".system")).toBe(false)
    expect(result.descriptors.find((item) => item.name === "ralplan")).toEqual(PROTECTED_WORKFLOWS.find((item) => item.name === "ralplan"))
    // An import-root skill is capturable through the same identity discovery reported.
    const captured = await captureSkill(roots, await findDescriptor("codex-only"))
    expect(captured.descriptor.identity).toBe("home:.codex/skills/codex-only")
  })

  test("a symlinked GJC base aliasing another root adds nothing; any other symlinked base stays local to that base", async () => {
    writeSkill("agents-skill")
    mkdirSync(join(project, ".gjc"), { recursive: true })
    symlinkSync("../.agents/skills", join(project, ".gjc/skills"))
    let result = await discoverSkills(roots)
    expect(result.descriptors.find((item) => item.name === "agents-skill")?.identity).toBe("project:.agents/skills/agents-skill")
    expect(result.refusals).toEqual([])

    rmSync(join(project, ".gjc/skills"))
    mkdirSync(join(project, "elsewhere/other"), { recursive: true })
    symlinkSync("../elsewhere", join(project, ".gjc/skills"))
    result = await discoverSkills(roots)
    // The refused optional base never hides the project's other skills.
    expect(result.descriptors.find((item) => item.name === "agents-skill")).toBeDefined()
    expect(result.refusals).toEqual([expect.objectContaining({ source: "project", reason: "unsafe-path", identities: ["project:.gjc/skills"] })])
  })

  test("refuses malformed metadata and validates allowed-tools against the execution tool registry", async () => {
    writeSkill("malformed")
    writeFileSync(join(project, BASE, "malformed", "SKILL.md"), "---\nname: [broken\ndescription: no\n---\n")
    writeSkill("invalid-tools", { allowedTools: "[read, invented_tool]" })
    writeSkill("valid-tools", { allowedTools: "[read, grep, task]" })

    const result = await discoverSkills(roots)
    expect(result.descriptors.some((item) => item.name === "malformed" || item.name === "invalid-tools")).toBe(false)
    expect(result.refusals.some((item) => item.name === "malformed" && item.reason === "invalid-metadata")).toBe(true)
    expect(result.refusals.some((item) => item.name === "invalid-tools" && item.reason === "invalid-metadata")).toBe(true)
    const valid = result.descriptors.find((item) => item.name === "valid-tools")
    expect(valid?.kind === "skill" ? valid.allowedTools : undefined).toEqual(["read", "grep", "task"])
  })
})

describe("exact skill capture", () => {
  test("proves a clean common project tree and preserves raw bytes in an immutable snapshot", async () => {
    const bytes = Buffer.from("---\r\nname: exact\r\ndescription: Exact UTF-8 capture — preserve CRLF.\r\n---\r\n\r\n# 原文\r\n", "utf8")
    const directory = skillDirectory("exact")
    writeFileSync(join(directory, "SKILL.md"), bytes)
    writeFileSync(join(directory, "reference.txt"), Buffer.from([0, 1, 2, 255]))
    commitAll()

    const selected = await findDescriptor("exact")
    const first = await captureSkill(roots, selected)
    const second = await captureSkill(roots, selected)
    const revalidated = await revalidateSkillCapture(roots, first)
    expect(isAuthenticCommonSkillCapture(first)).toBe(true)
    expect(authenticSkillClassification(first)).toBe("common")
    expect(first.contentHash).toBe(second.contentHash)
    expect(revalidated.unchanged).toBe(true)
    expect(revalidated.capture).not.toBe(first)
    expect(Buffer.from(readCapturedSkill(first)!)).toEqual(bytes)
    expect(Buffer.from(readCapturedFile(first, "reference.txt")!)).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(Object.isFrozen(first)).toBe(true)
    const exposed = readCapturedSkill(first)!
    exposed[0] = 0
    expect(Buffer.from(readCapturedSkill(first)!)).toEqual(bytes)
    expect(isAuthenticSkillCapture(structuredClone(first))).toBe(false)
    expect(isAuthenticCommonSkillCapture({ ...first, classification: "common" })).toBe(false)

    const builtin = await captureSkill(roots, PROTECTED_WORKFLOWS[0]!)
    expect(builtin.descriptor.kind).toBe("protected-workflow")
    expect(isAuthenticCommonSkillCapture(builtin)).toBe(true)
    expect(readCapturedSkill(builtin)).toBeUndefined()
  })

  test("capture tree entries match git ls-tree path, mode and content hash including an executable", async () => {
    const directory = writeSkill("exact-tree")
    const script = join(directory, "tools", "run.sh")
    mkdirSync(join(directory, "tools"), { recursive: true })
    writeFileSync(script, "#!/bin/sh\nexit 0\n")
    chmodSync(script, 0o755)
    writeFileSync(join(directory, "notes.txt"), Buffer.from([0, 255, 13, 10, 7]))
    commitAll()
    const captured = await captureSkill(roots, await findDescriptor("exact-tree"))
    expect(captured.classification).toBe("common")
    const prefix = `${BASE}/exact-tree/`
    const listed = git(project, "ls-tree", "-r", "HEAD", "--", `${BASE}/exact-tree`).split("\n").map((line) => {
      const [meta, path] = line.split("\t") as [string, string]
      const [mode, type, oid] = meta.split(" ") as [string, string, string]
      return { mode, type, oid, path: path.slice(prefix.length) }
    })
    expect(listed.map((item) => item.path).sort()).toEqual(["SKILL.md", "notes.txt", "tools/run.sh"])
    expect(listed.find((item) => item.path === "tools/run.sh")!.mode).toBe("100755")
    expect(captured.files.map((file) => file.path)).toEqual([...listed.map((item) => item.path)].sort())
    for (const item of listed) {
      expect(item.type).toBe("blob")
      const file = captured.files.find((candidate) => candidate.path === item.path)!
      expect(file).toBeDefined()
      expect((file.mode & 0o111) !== 0 ? "100755" : "100644").toBe(item.mode)
      const blob = execFileSync(REAL_GIT, ["cat-file", "blob", item.oid], { cwd: project })
      expect(file.sha256).toBe(createHash("sha256").update(blob).digest("hex"))
      expect(file.size).toBe(blob.byteLength)
      expect(Buffer.from(readCapturedFile(captured, item.path)!)).toEqual(blob)
      expect(execFileSync(REAL_GIT, ["hash-object", "--stdin"], { cwd: project, input: Buffer.from(readCapturedFile(captured, item.path)!) }).toString().trim()).toBe(item.oid)
      const entry = captured.entries.find((candidate) => candidate.path === item.path)!
      expect(entry.type).toBe("file")
      expect(entry.mode).toBe(file.mode)
    }
  })

  test("a gitlink inside a skill directory never classifies common", async () => {
    const directory = writeSkill("with-gitlink")
    commitAll()
    const nested = join(directory, "vendor")
    mkdirSync(nested)
    git(nested, "init", "--quiet")
    git(nested, "config", "user.name", "Nested")
    git(nested, "config", "user.email", "nested@example.invalid")
    writeFileSync(join(nested, "lib.txt"), "nested payload\n")
    git(nested, "add", "-A")
    git(nested, "commit", "--quiet", "-m", "nested")
    const nestedHead = git(nested, "rev-parse", "HEAD")
    git(project, "update-index", "--add", "--cacheinfo", `160000,${nestedHead},${BASE}/with-gitlink/vendor`)
    git(project, "commit", "--quiet", "-m", "gitlink")
    expect(git(project, "ls-tree", "HEAD", `${BASE}/with-gitlink/vendor`)).toStartWith("160000 commit ")
    let outcome: "custom" | "refused" | "common" = "common"
    try {
      outcome = (await captureSkill(roots, await findDescriptor("with-gitlink"))).classification === "common" ? "common" : "custom"
    } catch (error) {
      expect(error).toMatchObject({ reason: "unsafe" })
      outcome = "refused"
    }
    expect(outcome).not.toBe("common")
    // The same skill without the gitlink is common, so the demotion is caused by the gitlink and nothing else.
    git(project, "rm", "-q", "--cached", `${BASE}/with-gitlink/vendor`)
    rmSync(nested, { recursive: true, force: true })
    git(project, "commit", "--quiet", "-m", "remove gitlink")
    expect((await captureSkill(roots, await findDescriptor("with-gitlink"))).classification).toBe("common")
  })

  describe("Git snapshot races", () => {
    const kinds = {
      head: {
        mutation: `"$LCA_REAL_GIT" -c user.name=Racer -c user.email=racer@example.invalid -c commit.gpgsign=false commit --quiet --allow-empty -m "race-$LCA_RACE_N"`,
        expected: "common" as const,
      },
      index: {
        mutation: `echo "racer $LCA_RACE_N" > "racer-$LCA_RACE_N.txt" && "$LCA_REAL_GIT" add "racer-$LCA_RACE_N.txt"`,
        expected: "custom" as const,
      },
      file: {
        mutation: `printf 'racing bytes %s\\n' "$LCA_RACE_N" >> ${BASE}/racy/reference.txt`,
        expected: "custom" as const,
      },
    }
    for (const [kind, spec] of Object.entries(kinds)) {
      test(`one ${kind} race is retried and classified from the stable state; two races reject`, async () => {
        const directory = writeSkill("racy")
        writeFileSync(join(directory, "reference.txt"), "stable reference\n")
        commitAll()
        const descriptor = await findDescriptor("racy")
        const baseline = await captureSkill(roots, descriptor)
        expect(baseline.classification).toBe("common")
        const headBefore = git(project, "rev-parse", "HEAD")

        let race = installRaceGit(spec.mutation, "once")
        let captured
        try { captured = await captureSkill(roots, descriptor) } finally { race.restore() }
        expect(race.mutations()).toBe(1)
        expect(captured.classification).toBe(spec.expected)
        if (kind === "head") {
          expect(git(project, "rev-parse", "HEAD")).not.toBe(headBefore)
          expect(captured.contentHash).toBe(baseline.contentHash)
        } else if (kind === "index") {
          expect(git(project, "diff", "--cached", "--name-only")).toBe("racer-1.txt")
        } else {
          expect(Buffer.from(readCapturedFile(captured, "reference.txt")!).toString()).toBe("stable reference\nracing bytes 1\n")
          expect(captured.contentHash).not.toBe(baseline.contentHash)
        }

        // A persistent racer defeats the single retry: the capture is rejected, never admitted as common.
        rmSync(join(sandbox, "race-state"), { recursive: true, force: true })
        race = installRaceGit(spec.mutation, "always")
        let rejection: unknown
        try { await captureSkill(roots, descriptor) } catch (error) { rejection = error } finally { race.restore() }
        expect(race.mutations()).toBeGreaterThanOrEqual(2)
        expect(rejection).toMatchObject({ name: "SkillCaptureError", reason: "race" })
      })
    }
  })

  test("ignored and untracked extras demote the exact project tree", async () => {
    const directory = writeSkill("extras")
    writeFileSync(join(project, ".gitignore"), "*.ignored\n")
    commitAll()
    writeFileSync(join(directory, "ignored.ignored"), "ignored extra\n")
    expect((await captureSkill(roots, await findDescriptor("extras"))).classification).toBe("custom")
    rmSync(join(directory, "ignored.ignored"))
    writeFileSync(join(directory, "untracked.txt"), "untracked extra\n")
    expect((await captureSkill(roots, await findDescriptor("extras"))).classification).toBe("custom")
  })

  test("staged-versus-working disagreement, staged modes, and conflicts are custom", async () => {
    const directory = writeSkill("staged")
    const notes = join(directory, "notes.txt")
    writeFileSync(notes, "base\n")
    commitAll()
    writeFileSync(notes, "working-tree content\n")
    expect((await captureSkill(roots, await findDescriptor("staged"))).classification).toBe("custom")
    writeFileSync(notes, "staged content\n")
    git(project, "add", join(BASE, "staged", "notes.txt"))
    writeFileSync(notes, "base\n")
    expect((await captureSkill(roots, await findDescriptor("staged"))).classification).toBe("custom")

    git(project, "reset", "--quiet", "HEAD", "--", join(BASE, "staged", "notes.txt"))
    git(project, "update-index", "--chmod=+x", join(BASE, "staged", "notes.txt"))
    expect((await captureSkill(roots, await findDescriptor("staged"))).classification).toBe("custom")

    git(project, "reset", "--quiet", "HEAD", "--", join(BASE, "staged", "notes.txt"))
    const baseCommit = git(project, "rev-parse", "HEAD")
    git(project, "checkout", "--quiet", "-b", "left")
    writeFileSync(notes, "left side\n")
    commitAll("left")
    git(project, "checkout", "--quiet", "-b", "right", baseCommit)
    writeFileSync(notes, "right side\n")
    commitAll("right")
    expect(() => git(project, "merge", "--no-edit", "left")).toThrow()
    expect(git(project, "ls-files", "--unmerged")).not.toBe("")
    expect((await captureSkill(roots, await findDescriptor("staged"))).classification).toBe("custom")
  })

  test("working-tree modes and active clean/smudge or eol transforms are conservative custom provenance", async () => {
    const modeDirectory = writeSkill("mode")
    const executable = join(modeDirectory, "script.sh")
    writeFileSync(executable, "#!/bin/sh\nexit 0\n")
    commitAll()
    chmodSync(executable, 0o755)
    expect((await captureSkill(roots, await findDescriptor("mode"))).classification).toBe("custom")

    rmSync(project, { recursive: true, force: true })
    project = join(sandbox, "project-transforms")
    mkdirSync(project)
    git(project, "init", "--quiet")
    git(project, "config", "user.name", "Capture Fixture")
    git(project, "config", "user.email", "capture@example.invalid")
    git(project, "config", "core.filemode", "true")
    git(project, "config", "core.autocrlf", "false")
    git(project, "config", "core.eol", "lf")
    roots = await resolveSkillRoots({ projectRoot: project, homeDirectory: home })
    writeSkill("eol")
    writeFileSync(join(project, ".gitattributes"), "*.md text eol=crlf\n")
    commitAll("eol attributes")
    expect((await captureSkill(roots, await findDescriptor("eol"))).classification).toBe("custom")

    rmSync(project, { recursive: true, force: true })
    project = join(sandbox, "project-filter")
    mkdirSync(project)
    git(project, "init", "--quiet")
    git(project, "config", "user.name", "Capture Fixture")
    git(project, "config", "user.email", "capture@example.invalid")
    git(project, "config", "core.filemode", "true")
    git(project, "config", "core.autocrlf", "false")
    git(project, "config", "core.eol", "lf")
    roots = await resolveSkillRoots({ projectRoot: project, homeDirectory: home })
    writeSkill("filter")
    writeFileSync(join(project, ".gitattributes"), "SKILL.md filter=probe\n")
    commitAll("filter attributes")
    const marker = join(sandbox, "filter-executed")
    git(project, "config", "filter.probe.clean", `touch ${marker} && cat`)
    git(project, "config", "filter.probe.smudge", `touch ${marker} && cat`)
    expect((await captureSkill(roots, await findDescriptor("filter"))).classification).toBe("custom")
    expect(() => readFileSync(marker)).toThrow()
  })

  test("safe tracked internal links are common while escaping links require explicit capture-read consent", async () => {
    const shared = join(project, ".agents", "shared")
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, "reference.txt"), "tracked reference\n")
    const directory = writeSkill("links")
    symlinkSync("../../shared/reference.txt", join(directory, "reference.txt"))
    commitAll("internal link")
    const internal = await captureSkill(roots, await findDescriptor("links"))
    expect(internal.classification).toBe("common")
    expect(Buffer.from(readCapturedFile(internal, "reference.txt")!)).toEqual(Buffer.from("tracked reference\n"))

    const external = join(sandbox, "outside.txt")
    writeFileSync(external, "external custom bytes\n")
    symlinkSync(external, join(directory, "outside.txt"))
    commitAll("escaping link")

    const selected = await findDescriptor("links")
    let consentRequired: unknown
    try {
      await captureSkill(roots, selected)
    } catch (error) {
      consentRequired = error
    }
    expect(consentRequired).toMatchObject({ reason: "external-consent-required", externalTargets: [external] })

    const captured = await captureSkill(roots, selected, { consentedExternalTargets: [external] })
    expect(captured.classification).toBe("custom")
    expect(Buffer.from(readCapturedFile(captured, "reference.txt")!)).toEqual(Buffer.from("tracked reference\n"))
    expect(Buffer.from(readCapturedFile(captured, "outside.txt")!)).toEqual(Buffer.from("external custom bytes\n"))
    expect(readCapturedFile(captured, external)).toBeUndefined()
    expect(captured.entries.some((entry) => entry.path === "reference.txt" && entry.type === "symlink")).toBe(true)
  })

  test("escaped descriptor links require explicit consent before discovery and capture", async () => {
    const directory = writeSkill("external-descriptor")
    const descriptorPath = join(directory, "SKILL.md")
    const bytes = readFileSync(descriptorPath)
    const external = join(sandbox, "external-SKILL.md")
    rmSync(descriptorPath)
    writeFileSync(external, bytes)
    symlinkSync(external, descriptorPath)

    const refused = await discoverSkills(roots)
    expect(refused.descriptors.some((item) => item.name === "external-descriptor")).toBe(false)
    expect(refused.refusals.some((item) => item.name === "external-descriptor" &&
      item.reason === "external-consent-required" && item.externalTargets?.includes(external))).toBe(true)

    const approvedDiscovery = await discoverSkills(roots, { consentedExternalTargets: [external] })
    const descriptor = approvedDiscovery.descriptors.find((item) => item.name === "external-descriptor")
    expect(descriptor?.kind).toBe("skill")
    const captured = await captureSkill(roots, descriptor!, { consentedExternalTargets: [external] })
    expect(captured.classification).toBe("custom")
    expect(Buffer.from(readCapturedSkill(captured)!)).toEqual(bytes)
  })

  test("SHA-256 Git objects prove raw binary bytes and reject staged disagreement", async () => {
    const shaProject = join(sandbox, "sha256-project")
    mkdirSync(shaProject)
    git(shaProject, "init", "--quiet", "--object-format=sha256")
    const shaRoots = await resolveSkillRoots({ projectRoot: shaProject, homeDirectory: home })
    const directory = writeSkill("sha-skill", { root: shaProject })
    const bytes = Buffer.from([0, 1, 255, 13, 10, 128])
    writeFileSync(join(directory, "payload.bin"), bytes)
    git(shaProject, "add", "-A")
    git(shaProject, "commit", "--quiet", "-m", "SHA-256 fixture")
    expect(git(shaProject, "rev-parse", "--show-object-format")).toBe("sha256")
    const descriptor = await findDescriptor("sha-skill", shaRoots)
    const clean = await captureSkill(shaRoots, descriptor)
    expect(isAuthenticCommonSkillCapture(clean)).toBe(true)
    expect(Buffer.from(readCapturedFile(clean, "payload.bin")!)).toEqual(bytes)
    writeFileSync(join(directory, "payload.bin"), Buffer.from([0, 1, 254, 13, 10, 128]))
    expect((await captureSkill(shaRoots, descriptor)).classification).toBe("custom")
    git(shaProject, "add", "-A")
    writeFileSync(join(directory, "payload.bin"), bytes)
    expect((await captureSkill(shaRoots, descriptor)).classification).toBe("custom")
    expect(Buffer.from(readCapturedFile(clean, "payload.bin")!)).toEqual(bytes)
  })

  test("a cyclic symlink fails unsafe rather than producing a capture", async () => {
    const directory = writeSkill("cycle")
    symlinkSync("loop", join(directory, "loop"))
    commitAll()
    await expect(captureSkill(roots, await findDescriptor("cycle"))).rejects.toMatchObject({ reason: "unsafe" })
  })

  test("home skills are always custom and repeated capture cannot change earlier bytes", async () => {
    const local = writeSkill("home-skill", { root: home, base: ".config/opencode/skills" })
    writeFileSync(join(local, "reference.js"), "export const value = 1\n")
    const first = await captureSkill(roots, await findDescriptor("home-skill"))
    expect(first.source).toBe("home")
    expect(first.classification).toBe("custom")
    expect(isAuthenticCommonSkillCapture(first)).toBe(false)
    const originalHash = first.contentHash
    const originalBytes = Buffer.from(readCapturedFile(first, "reference.js")!)

    writeFileSync(join(local, "reference.js"), "export const value = 2\n")
    const second = await captureSkill(roots, await findDescriptor("home-skill"))
    const revalidated = await revalidateSkillCapture(roots, first)
    expect(second.contentHash).not.toBe(originalHash)
    expect(revalidated.unchanged).toBe(false)
    expect(revalidated.capture.contentHash).not.toBe(originalHash)
    expect(Buffer.from(readCapturedFile(first, "reference.js")!)).toEqual(originalBytes)
    expect(Buffer.from(readCapturedFile(second, "reference.js")!)).not.toEqual(originalBytes)
  })
})
