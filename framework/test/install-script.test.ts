import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."))
const script = join(repo, "install.sh")
const wslScript = join(repo, "scripts", "otter-wsl")
const bun = realpathSync(process.execPath)
let home: string

function run(args: string[] = [], env: Record<string, string> = {}, input?: string) {
  const result = spawnSync("bash", input === undefined ? [script, ...args] : ["-s", "--", ...args], {
    input,
    env: {
      HOME: home, SHELL: "/bin/zsh", PATH: `${dirname(bun)}:/usr/bin:/bin`,
      // Install the committed HEAD of this checkout; no network or credentials needed.
      OTTER_REPO: `file://${repo}`, OTTER_REF: "HEAD", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      ...env,
    },
    encoding: "utf8",
    timeout: 120_000,
  })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}

function findFish(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, "fish")
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0) return candidate
    } catch {}
  }
}

function fishShell(): string {
  const configDir = join(home, ".config", "fish")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "config.fish"), 'set -gx PATH "$OTTER_TEST_INITIALIZED_PATH" $PATH\n')

  const fish = findFish()
  if (fish) return fish

  // Test-only Fish mock for hosts without Fish; verify the Fish command and emulate its argv-list handoff.
  const mockDir = join(home, "mock-fish")
  mkdirSync(mockDir)
  const mock = join(mockDir, "fish")
  writeFileSync(mock, `#!/bin/sh
[ "$1" = -lc ] || exit 97
[ "$2" = 'exec /bin/sh $argv' ] || exit 98
shift 2
PATH="$OTTER_TEST_INITIALIZED_PATH:$PATH"
export PATH
exec /bin/sh "$@"
`)
  chmodSync(mock, 0o755)
  return mock
}

function bashLoginShell(initializedPath: string): string {
  mkdirSync(initializedPath, { recursive: true })
  writeFileSync(join(home, ".bash_profile"), 'PATH="$OTTER_TEST_INITIALIZED_PATH:$PATH"\nexport PATH\n')
  return "/bin/bash"
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw new Error("install-script tests require process.getuid support")
  return process.getuid()
}

function mockGetent(passwdShell: string, status = 0) {
  const mockDir = join(home, "mock-getent")
  mkdirSync(mockDir)
  const mock = join(mockDir, "getent")
  writeFileSync(mock, `#!/bin/sh
printf '%s\\n' "$@" > "$OTTER_TEST_GETENT_ARGS_FILE"
[ "$1" = passwd ] || exit 97
[ "$2" = "$OTTER_TEST_UID" ] || exit 98
[ "$OTTER_TEST_GETENT_STATUS" = 0 ] || exit "$OTTER_TEST_GETENT_STATUS"
printf 'otter:x:%s:1000:Otter:%s:%s\\n' "$OTTER_TEST_UID" "$HOME" "$OTTER_TEST_PASSWD_SHELL"
`)
  chmodSync(mock, 0o755)
  return { dir: mockDir, passwdShell, status }
}

function runWsl(shell: string | undefined, args: string[], initializedPath?: string, getent?: ReturnType<typeof mockGetent>) {
  const launcher = join(home, "otter-launcher")
  const argsFile = join(home, "launcher-args")
  const pathFile = join(home, "launcher-path")
  const getentArgsFile = join(home, "getent-args")
  writeFileSync(launcher, `#!/bin/sh
printf '%s\\n' "$@" > "$OTTER_TEST_ARGS_FILE"
printf '%s' "$PATH" > "$OTTER_TEST_PATH_FILE"
`)
  chmodSync(launcher, 0o755)

  // macOS /bin/sh synthesizes SHELL at startup; unset it after startup to exercise the WSL missing-SHELL case.
  const shellArgs = shell === undefined
    ? ["-c", 'unset SHELL; script=$1; shift; . "$script"', wslScript, wslScript, launcher, ...args]
    : [wslScript, launcher, ...args]
  const result = spawnSync("/bin/sh", shellArgs, {
    env: {
      HOME: home,
      ...(shell === undefined ? {} : { SHELL: shell }),
      PATH: getent ? `${getent.dir}${delimiter}/usr/bin:/bin` : "/usr/bin:/bin",
      BROWSER: "/bin/true",
      OTTER_TEST_ARGS_FILE: argsFile,
      OTTER_TEST_PATH_FILE: pathFile,
      OTTER_TEST_GETENT_ARGS_FILE: getentArgsFile,
      OTTER_TEST_UID: String(currentUid()),
      OTTER_TEST_GETENT_STATUS: String(getent?.status ?? 0),
      OTTER_TEST_PASSWD_SHELL: getent?.passwdShell ?? "",
      ...(initializedPath ? { OTTER_TEST_INITIALIZED_PATH: initializedPath } : {}),
    },
    encoding: "utf8",
    timeout: 10_000,
  })
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    args: existsSync(argsFile) ? readFileSync(argsFile, "utf8").split("\n").slice(0, -1) : undefined,
    path: existsSync(pathFile) ? readFileSync(pathFile, "utf8") : undefined,
    getentArgs: existsSync(getentArgsFile) ? readFileSync(getentArgsFile, "utf8").split("\n").slice(0, -1) : undefined,
  }
}

beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "otter-install-"))) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

test("one command installs a working launcher, updates in place, and uninstalls only what it created", () => {
  writeFileSync(join(home, ".zshrc"), "existing line\n")
  const first = run()
  expect(first.code).toBe(0)
  const shim = join(home, ".local/bin/otter")
  expect(readFileSync(shim, "utf8")).toContain("# managed by the otter installer")
  const help = spawnSync(shim, ["--help"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } })
  expect(help.status).toBe(0)
  expect(help.stdout).toContain("Usage:")
  const rc = readFileSync(join(home, ".zshrc"), "utf8")
  expect(rc).toContain(`export PATH='${join(home, ".local/bin")}':"$PATH"`)

  // Re-running updates in place and never duplicates the PATH block.
  expect(run().code).toBe(0)
  expect(readFileSync(join(home, ".zshrc"), "utf8").split("# >>> otter installer >>>").length).toBe(2)

  // A modified checkout is never overwritten.
  const readme = join(home, ".local/share/otter/AgentFramework/README.md")
  writeFileSync(readme, `${readFileSync(readme, "utf8")}local edit\n`)
  const dirty = run()
  expect(dirty.code).toBe(1)
  expect(dirty.out).toContain("has local changes")
  spawnSync("git", ["-C", dirname(readme), "checkout", "-q", "--", "README.md"])

  const removed = run(["--uninstall"])
  expect(removed.code).toBe(0)
  expect(existsSync(shim)).toBe(false)
  expect(existsSync(join(home, ".local/share/otter"))).toBe(false)
  expect(readFileSync(join(home, ".zshrc"), "utf8")).not.toContain("otter installer")
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain("existing line")
}, 180_000)

test("the installer works when piped into bash and refuses to replace a launcher it did not create", () => {
  const binDir = join(home, "bin")
  spawnSync("mkdir", ["-p", binDir])
  writeFileSync(join(binDir, "otter"), "#!/bin/sh\necho mine\n")
  const refused = run([], { OTTER_BIN_DIR: binDir, OTTER_NO_MODIFY_PATH: "1" }, readFileSync(script, "utf8"))
  expect(refused.code).toBe(1)
  expect(refused.out).toContain("was not created by this installer")
  expect(readFileSync(join(binDir, "otter"), "utf8")).toBe("#!/bin/sh\necho mine\n")

  const piped = run([], { OTTER_NO_MODIFY_PATH: "1" }, readFileSync(script, "utf8"))
  expect(piped.code).toBe(0)
  expect(piped.out).toContain("installed:")
  expect(existsSync(join(home, ".zshrc"))).toBe(false)
}, 180_000)

test("missing bun fails with guidance when automatic bun installation is disabled", () => {
  const result = spawnSync("bash", [script], {
    env: { HOME: home, PATH: "/usr/bin:/bin", OTTER_NO_BUN_INSTALL: "1" }, encoding: "utf8",
  })
  expect(result.status).toBe(1)
  expect(`${result.stdout}${result.stderr}`).toContain("bun >= 1.2 is required")
})

test("Fish handoff preserves argv spaces and metacharacters (using a labeled mock only when Fish is unavailable)", () => {
  const initializedPath = join(home, "fish-login-bin")
  mkdirSync(initializedPath)
  const shell = fishShell()
  const args = ["space argument", "literal*glob", "semi;colon", "$(not-executed)", "$HOME", "question?"]

  const result = runWsl(shell, args, initializedPath)
  expect(result.code).toBe(0)
  expect(result.args).toEqual(args)
})

test("non-Fish shells retain the POSIX handoff and preserve argv boundaries", () => {
  const args = ["space argument", "literal*glob", "semi;colon", "$(not-executed)"]

  const result = runWsl("/bin/bash", args)
  expect(result.code).toBe(0)
  expect(result.args).toEqual(args)
})

test("Fish login initialization PATH reaches the launcher", () => {
  const initializedPath = join(home, "fish-login-bin")
  mkdirSync(initializedPath)

  const result = runWsl(fishShell(), [], initializedPath)
  expect(result.code).toBe(0)
  expect(result.path?.split(delimiter)).toContain(initializedPath)
})

test("missing SHELL resolves the current UID passwd shell and preserves its initialized PATH", () => {
  const initializedPath = join(home, "bash-login-bin")
  const shell = bashLoginShell(initializedPath)
  const result = runWsl(undefined, [], initializedPath, mockGetent(shell))

  expect(result.code).toBe(0)
  expect(result.path?.split(delimiter)).toContain(initializedPath)
  expect(result.getentArgs).toEqual(["passwd", String(currentUid())])
})

test("a non-absolute SHELL resolves through the passwd login shell", () => {
  const initializedPath = join(home, "bash-login-bin")
  const shell = bashLoginShell(initializedPath)
  const result = runWsl("bash", [], initializedPath, mockGetent(shell))

  expect(result.code).toBe(0)
  expect(result.path?.split(delimiter)).toContain(initializedPath)
  expect(result.getentArgs).toEqual(["passwd", String(currentUid())])
})

test("unavailable getent retains the /bin/sh fallback", () => {
  const initializedPath = join(home, "bash-login-bin")
  bashLoginShell(initializedPath)
  const result = runWsl(undefined, [], initializedPath, mockGetent("/bin/bash", 127))

  expect(result.code).toBe(0)
  expect(result.path?.split(delimiter)).not.toContain(initializedPath)
  expect(result.getentArgs).toEqual(["passwd", String(currentUid())])
})

test("a valid explicit SHELL takes precedence over the passwd shell", () => {
  const initializedPath = join(home, "bash-login-bin")
  const shell = bashLoginShell(initializedPath)
  const result = runWsl(shell, [], initializedPath, mockGetent("/bin/sh"))

  expect(result.code).toBe(0)
  expect(result.path?.split(delimiter)).toContain(initializedPath)
  expect(result.getentArgs).toBeUndefined()
})
