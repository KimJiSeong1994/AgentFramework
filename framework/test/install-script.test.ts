import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."))
const script = join(repo, "install.sh")
const bun = realpathSync(process.execPath)
let home: string

function run(args: string[] = [], env: Record<string, string> = {}, input?: string) {
  const result = spawnSync("bash", input === undefined ? [script, ...args] : ["-s", "--", ...args], {
    input,
    env: {
      HOME: home, SHELL: "/bin/zsh", PATH: `${dirname(bun)}:/usr/bin:/bin`,
      // Install the committed HEAD of this checkout; no network or credentials needed.
      LCA_REPO: `file://${repo}`, LCA_REF: "HEAD", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      ...env,
    },
    encoding: "utf8",
    timeout: 120_000,
  })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}

beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "lca-install-"))) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

test("one command installs a working launcher, updates in place, and uninstalls only what it created", () => {
  writeFileSync(join(home, ".zshrc"), "existing line\n")
  const first = run()
  expect(first.code).toBe(0)
  const shim = join(home, ".local/bin/lca")
  expect(readFileSync(shim, "utf8")).toContain("# managed by the lca installer")
  const help = spawnSync(shim, ["--help"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } })
  expect(help.status).toBe(0)
  expect(help.stdout).toContain("Usage:")
  const rc = readFileSync(join(home, ".zshrc"), "utf8")
  expect(rc).toContain(`export PATH='${join(home, ".local/bin")}':"$PATH"`)

  // Re-running updates in place and never duplicates the PATH block.
  expect(run().code).toBe(0)
  expect(readFileSync(join(home, ".zshrc"), "utf8").split("# >>> lca installer >>>").length).toBe(2)

  // A modified checkout is never overwritten.
  const readme = join(home, ".local/share/lca/AgentFramework/README.md")
  writeFileSync(readme, `${readFileSync(readme, "utf8")}local edit\n`)
  const dirty = run()
  expect(dirty.code).toBe(1)
  expect(dirty.out).toContain("has local changes")
  spawnSync("git", ["-C", dirname(readme), "checkout", "-q", "--", "README.md"])

  const removed = run(["--uninstall"])
  expect(removed.code).toBe(0)
  expect(existsSync(shim)).toBe(false)
  expect(existsSync(join(home, ".local/share/lca"))).toBe(false)
  expect(readFileSync(join(home, ".zshrc"), "utf8")).not.toContain("lca installer")
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain("existing line")
}, 180_000)

test("the installer works when piped into bash and refuses to replace a launcher it did not create", () => {
  const binDir = join(home, "bin")
  spawnSync("mkdir", ["-p", binDir])
  writeFileSync(join(binDir, "lca"), "#!/bin/sh\necho mine\n")
  const refused = run([], { LCA_BIN_DIR: binDir, LCA_NO_MODIFY_PATH: "1" }, readFileSync(script, "utf8"))
  expect(refused.code).toBe(1)
  expect(refused.out).toContain("was not created by this installer")
  expect(readFileSync(join(binDir, "lca"), "utf8")).toBe("#!/bin/sh\necho mine\n")

  const piped = run([], { LCA_NO_MODIFY_PATH: "1" }, readFileSync(script, "utf8"))
  expect(piped.code).toBe(0)
  expect(piped.out).toContain("installed:")
  expect(existsSync(join(home, ".zshrc"))).toBe(false)
}, 180_000)

test("missing bun fails with guidance when automatic bun installation is disabled", () => {
  const result = spawnSync("bash", [script], {
    env: { HOME: home, PATH: "/usr/bin:/bin", LCA_NO_BUN_INSTALL: "1" }, encoding: "utf8",
  })
  expect(result.status).toBe(1)
  expect(`${result.stdout}${result.stderr}`).toContain("bun >= 1.2 is required")
})
