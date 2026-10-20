import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkForUpdate, readInstall, updateCheckEnabled, updateCli, updateNoticeText, type UpdateCheckDeps } from "../src/hosts/update-check.ts"

const LOCAL = "a".repeat(40)
const REMOTE = "b".repeat(40)

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "otter-update-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function managed(marker: string): string {
  const root = join(dir, "AgentFramework")
  mkdirSync(join(root, ".git"), { recursive: true })
  writeFileSync(join(root, ".git", "otter-installer"), marker)
  return root
}

function fakeGit(answers: { head?: string; remote?: string | Error }) {
  const calls: string[][] = []
  let clock = 1_000_000
  const deps: UpdateCheckDeps = {
    now: () => clock,
    git: async (_cwd, args) => {
      calls.push([...args])
      if (args[0] === "rev-parse") return `${answers.head ?? LOCAL}\n`
      if (answers.remote instanceof Error) throw answers.remote
      return answers.remote ?? ""
    },
    cachePath: join(dir, "state", "update-check.json"),
    ttlMs: 60_000,
  }
  return { deps, calls, advance: (ms: number) => { clock += ms } }
}

describe("installer marker", () => {
  test("reads repo, ref and launcher directory; a marker from an older installer follows master", () => {
    expect(readInstall(managed("repo=https://example.test/otter.git\nref=release\nbin=/home/u/bin\n")))
      .toMatchObject({ repo: "https://example.test/otter.git", ref: "release", binDir: "/home/u/bin" })
    rmSync(join(dir, "AgentFramework"), { recursive: true })
    expect(readInstall(managed("repo=https://example.test/otter.git\n"))).toMatchObject({ ref: "master" })
    expect(readInstall(managed("repo=https://example.test/otter.git\n"))?.binDir).toBeUndefined()
  })

  test("a source checkout (no marker, or no repo) is not an installation", () => {
    mkdirSync(join(dir, "src", ".git"), { recursive: true })
    expect(readInstall(join(dir, "src"))).toBeUndefined()
    expect(readInstall(managed("ref=master\n"))).toBeUndefined()
  })
})

describe("startup update check", () => {
  const install = () => readInstall(managed("repo=https://example.test/otter.git\nref=master\n"))!

  test("a moved remote branch produces a notice that says how to update", async () => {
    const { deps, calls } = fakeGit({ remote: `${REMOTE}\trefs/heads/master\n` })
    const notice = await checkForUpdate(install(), deps)
    expect(notice).toEqual({ current: "aaaaaaa", latest: "bbbbbbb", ref: "master" })
    expect(updateNoticeText(notice!)).toBe("Update available: a newer otter is on master (aaaaaaa -> bbbbbbb). Run: otter update")
    expect(calls[1]).toEqual(["ls-remote", "--", "https://example.test/otter.git", "refs/heads/master"])
  })

  test("an installation at the branch head gets no notice", async () => {
    const { deps } = fakeGit({ remote: `${LOCAL}\trefs/heads/master\n` })
    expect(await checkForUpdate(install(), deps)).toBeUndefined()
  })

  test("the remote is asked at most once per interval for the same installed commit", async () => {
    const git = fakeGit({ remote: `${REMOTE}\trefs/heads/master\n` })
    await checkForUpdate(install(), git.deps)
    expect(await checkForUpdate(install(), git.deps)).toMatchObject({ latest: "bbbbbbb" })
    expect(git.calls.filter(args => args[0] === "ls-remote")).toHaveLength(1)
    git.advance(60_001)
    await checkForUpdate(install(), git.deps)
    expect(git.calls.filter(args => args[0] === "ls-remote")).toHaveLength(2)
  })

  test("after an update the cached answer for the old commit is not reused", async () => {
    const before = fakeGit({ remote: `${REMOTE}\trefs/heads/master\n` })
    await checkForUpdate(install(), before.deps)
    const after = fakeGit({ head: REMOTE, remote: `${REMOTE}\trefs/heads/master\n` })
    expect(await checkForUpdate(install(), after.deps)).toBeUndefined()
    expect(after.calls.some(args => args[0] === "ls-remote")).toBe(true)
  })

  test.each([
    ["an unreachable remote", new Error("network down")],
    ["a pinned tag or commit (no such branch)", ""],
    ["a malformed answer", "not-a-commit\trefs/heads/master\n"],
  ])("%s never fails startup and shows no notice", async (_label, remote) => {
    const { deps } = fakeGit({ remote })
    expect(await checkForUpdate(install(), deps)).toBeUndefined()
  })

  test("update.check false or OTTER_NO_UPDATE_CHECK=1 disables the check; a broken config does not", () => {
    const path = join(dir, "otter.jsonc")
    expect(updateCheckEnabled(path)).toBe(true)
    writeFileSync(path, '{ // user\n  "update": { "check": false }\n}\n')
    expect(updateCheckEnabled(path)).toBe(false)
    writeFileSync(path, '{ "update": { "check": true } }')
    expect(updateCheckEnabled(path)).toBe(true)
    writeFileSync(path, "{ not json")
    expect(updateCheckEnabled(path)).toBe(true)
    process.env.OTTER_NO_UPDATE_CHECK = "1"
    try { expect(updateCheckEnabled(join(dir, "missing.jsonc"))).toBe(false) }
    finally { delete process.env.OTTER_NO_UPDATE_CHECK }
  })
})

describe("otter update", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, stdio: "pipe", encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim()

  test("a source checkout is refused with how to update it", async () => {
    mkdirSync(join(dir, "src", ".git"), { recursive: true })
    expect(await updateCli([], join(dir, "src"))).toBe(1)
  })

  test("usage errors exit 2", async () => {
    expect(await updateCli(["--force"], dir)).toBe(2)
  })

  test("--check reports against the real remote branch head, then re-running the installer brings the copy up to date", async () => {
    const upstream = join(dir, "upstream")
    mkdirSync(upstream)
    git(upstream, "init", "-q", "-b", "master")
    git(upstream, "config", "user.email", "t@t"); git(upstream, "config", "user.name", "t")
    // A stand-in installer: records what `otter update` hands to install.sh and moves the copy to the branch head.
    writeFileSync(join(upstream, "install.sh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$OTTER_REPO" "$OTTER_REF" "$OTTER_HOME" "${OTTER_BIN_DIR:-}" "${OTTER_NO_MODIFY_PATH:-}" > "$OTTER_HOME/installer-env"',
      'git -C "$OTTER_HOME/AgentFramework" fetch -q origin "$OTTER_REF"',
      'git -C "$OTTER_HOME/AgentFramework" checkout -q --detach FETCH_HEAD',
    ].join("\n"))
    git(upstream, "add", "-A"); git(upstream, "commit", "-q", "-m", "one")

    const home = join(dir, "home")
    const root = join(home, "AgentFramework")
    mkdirSync(home)
    git(home, "clone", "-q", upstream, "AgentFramework")
    git(root, "checkout", "-q", "--detach")
    writeFileSync(join(root, ".git", "otter-installer"), `repo=${upstream}\nref=master\nbin=${join(dir, "bin")}\n`)

    process.env.OTTER_STATE_HOME = join(dir, "state")
    try {
      const lines: string[] = []
      const log = console.log
      console.log = (text: string) => { lines.push(text) }
      try {
        expect(await updateCli(["--check"], root)).toBe(0)
        writeFileSync(join(upstream, "next.txt"), "next\n")
        git(upstream, "add", "-A"); git(upstream, "commit", "-q", "-m", "two")
        expect(await updateCli(["--check"], root)).toBe(0)
      } finally { console.log = log }
      expect(lines[0]).toBe("otter is up to date with master.")
      expect(lines[1]).toMatch(/^Update available: a newer otter is on master \([0-9a-f]{7} -> [0-9a-f]{7}\)\. Run: otter update$/u)

      expect(await updateCli([], root)).toBe(0)
      // Same repository, branch, install root and launcher directory as the first install; the shell rc is never edited.
      expect(readFileSync(join(home, "installer-env"), "utf8").split("\n").slice(0, 5)).toEqual([upstream, "master", home, join(dir, "bin"), "1"])
      expect(git(root, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"))
    } finally {
      delete process.env.OTTER_STATE_HOME
    }
  })
})
