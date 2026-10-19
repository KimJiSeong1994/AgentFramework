import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { harnessProfile } from "../src/harness/profile.ts"
import { EXECUTION_ROLES } from "../src/hosts/types.ts"

let root: string
let home: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "otter-prof-")))
  home = realpathSync(mkdtempSync(join(tmpdir(), "otter-prof-home-")))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) })

function skill(body: string, name = "inspect") {
  const dir = join(root, ".agents", "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Inspect this project\n---\n${body}`)
}

test("fingerprint ignores chat, memory, skill_trust and skill_auto, but tracks a SKILL.md byte", async () => {
  skill("one\n")
  const base = await harnessProfile(DEFAULT_CONFIG, root, { homeDirectory: home })
  const noisy = { ...DEFAULT_CONFIG, chat: { default_model: { engine: "codex", model: "gpt-5-codex" } },
    memory: { ...DEFAULT_CONFIG.memory, engine: "claude", model: "haiku" }, skill_trust: ["inspect"], skill_auto: { mode: "auto" } } as unknown as typeof DEFAULT_CONFIG
  expect((await harnessProfile(noisy, root, { homeDirectory: home })).fingerprint).toBe(base.fingerprint)
  expect(base.skills).toEqual([expect.objectContaining({ name: "inspect", tier: "native", skillSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })])
  skill("two\n")
  const changed = await harnessProfile(DEFAULT_CONFIG, root, { homeDirectory: home })
  expect(changed.fingerprint).not.toBe(base.fingerprint)
  expect(changed.policyIDs).toEqual(base.policyIDs)
})

test("fingerprint changes when a role prompt-bearing config changes", async () => {
  const base = await harnessProfile(DEFAULT_CONFIG, root, { homeDirectory: home })
  const other = await harnessProfile({ ...DEFAULT_CONFIG, max_output: { ...DEFAULT_CONFIG.max_output, worker: DEFAULT_CONFIG.max_output.worker + 1 } }, root, { homeDirectory: home })
  expect(other.policyIDs.worker).not.toBe(base.policyIDs.worker)
  expect(other.fingerprint).not.toBe(base.fingerprint)
})

test("only the overlays are proposable; policy ids cover every role; no absolute paths", async () => {
  skill("x\n")
  const profile = await harnessProfile(DEFAULT_CONFIG, root, { homeDirectory: home })
  const proposable = profile.components.filter((c) => c.proposable).map((c) => c.id)
  expect(proposable).toEqual(["overlay.inv", "overlay.dom"])
  for (const id of ["c1.system", "c2.guardrails", "c4.tool_guidance", "c5.subagents", "c7.scripts", "c8.plugins_hooks"]) {
    expect(profile.components.find((c) => c.id === id)?.proposable).toBe(false)
  }
  expect(Object.keys(profile.policyIDs).sort()).toEqual([...EXECUTION_ROLES].sort())
  const json = JSON.stringify(profile)
  expect(json).not.toContain(root)
  expect(json).not.toContain(home)
  expect(json).not.toMatch(/"\/[A-Za-z]/)
})

test("CLI harness profile --json is read-only and has the profile shape (not live-model proof)", async () => {
  skill("x\n")
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/hosts/cli.ts"), "harness", "profile", "--worktree", root, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: join(home, "config"), HOME: home }, stdout: "pipe", stderr: "pipe" })
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return { code, out }
  }
  const json = await run(["--json"])
  expect(json.code).toBe(0)
  const parsed = JSON.parse(json.out)
  expect(parsed.schema).toBe("otter.harness-profile.v1")
  expect(parsed.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(parsed.skills.map((s: { name: string }) => s.name)).toContain("inspect")
  expect(json.out).not.toContain(root)
  const text = await run([])
  expect(text.code).toBe(0)
  expect(text.out).toContain(parsed.fingerprint)
  const bad = await run(["--bogus"])
  expect(bad.code).toBe(2)
})
