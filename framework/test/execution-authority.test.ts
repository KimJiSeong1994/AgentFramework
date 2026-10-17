import { afterEach, expect, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executionRunDirectory, stateRoot, worktreeKey } from "../src/state/store.ts"

const ENV_KEYS = ["HOME", "XDG_STATE_HOME", "OTTER_STATE_HOME"] as const
let envBefore: Record<typeof ENV_KEYS[number], string | undefined>
let restoreAccountLookup: (() => void) | undefined
const cleanups: Array<() => void> = []

afterEach(() => {
  restoreAccountLookup?.()
  restoreAccountLookup = undefined
  for (const key of ENV_KEYS) {
    const value = envBefore[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "otter-execution-authority-"))
  const worktree = join(root, "worktree")
  mkdirSync(worktree)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return { root, worktree }
}

function setStateEnv(values: Partial<Record<typeof ENV_KEYS[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function currentUID(): number {
  const uid = process.geteuid?.()
  if (typeof uid !== "number") throw new Error("test requires an operating-system UID")
  return uid
}

type AccountLookupOptions = {
  platform?: NodeJS.Platform
  accountName?: string
  idOutput?: string
  dsclOutput?: string
  plutilJsonOutput?: string
  passwdOutput?: string
  commandError?: Error
}

function stubOSIdentity(home: string, uid = currentUID(), options: AccountLookupOptions = {}) {
  restoreAccountLookup?.()
  const platform = options.platform ?? os.platform()
  const outputs = platform === "darwin" ? [
    options.idOutput ?? `${options.accountName ?? "execution-authority-test"}\n`,
    options.dsclOutput ?? "<plist><dict>fixture</dict></plist>",
    options.plutilJsonOutput ?? JSON.stringify({
      "dsAttrTypeStandard:UniqueID": [String(uid)],
      "dsAttrTypeStandard:NFSHomeDirectory": [home],
    }),
  ] : platform === "linux" ? [
    options.passwdOutput ?? `${options.accountName ?? "execution-authority-test"}:x:${uid}:${uid}:Test Account:${home}:/bin/sh\n`,
  ] : []
  const effectiveUID = spyOn(process, "geteuid").mockReturnValue(uid)
  const osPlatform = spyOn(os, "platform").mockReturnValue(platform)
  let commandIndex = 0
  const command = spyOn(childProcess, "execFileSync").mockImplementation(new Proxy(childProcess.execFileSync, {
    apply() {
      if (options.commandError) throw options.commandError
      const output = outputs[commandIndex++ % outputs.length]
      if (output === undefined) throw new Error("unexpected account lookup command")
      return output
    },
  }))
  restoreAccountLookup = () => {
    command.mockRestore()
    osPlatform.mockRestore()
    effectiveUID.mockRestore()
  }
  return { command, effectiveUID, osPlatform }
}

function authorityPath(homedir: string, worktree: string): string {
  return join(homedir, ".local", "state", "otter", worktreeKey(worktree), "execution-runs")
}

function createAuthority(homedir: string, worktree: string): string {
  const path = authorityPath(homedir, worktree)
  mkdirSync(path, { recursive: true })
  return path
}

function envSnapshot(): void {
  envBefore = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, OTTER_STATE_HOME: process.env.OTTER_STATE_HOME }
}

test("execution authority uses OS identity and is independent of HOME and state-root overrides", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const expected = createAuthority(osHome, f.worktree)
  stubOSIdentity(osHome)

  for (const values of [
    { HOME: join(f.root, "home-one"), XDG_STATE_HOME: join(f.root, "xdg-one") },
    { HOME: join(f.root, "home-two") },
    { HOME: join(f.root, "home-three"), XDG_STATE_HOME: join(f.root, "xdg-three"), OTTER_STATE_HOME: join(f.root, "otter-three") },
  ]) {
    setStateEnv(values)
    expect(executionRunDirectory(f.worktree)).toBe(realpathSync(expected))
    expect(stateRoot(f.worktree)).not.toBe(join(osHome, ".local", "state", "otter", worktreeKey(f.worktree)))
  }
})

test("account identity is revalidated for every directory resolution", () => {
  envSnapshot()
  const f = fixture()
  const firstHome = join(f.root, "first-os-home")
  const secondHome = join(f.root, "second-os-home")
  mkdirSync(firstHome)
  mkdirSync(secondHome)
  setStateEnv({ OTTER_STATE_HOME: join(f.root, "legacy-state") })

  stubOSIdentity(firstHome)
  const first = executionRunDirectory(f.worktree)
  stubOSIdentity(secondHome)
  const second = executionRunDirectory(f.worktree)

  expect(first).toBe(authorityPath(realpathSync(firstHome), f.worktree))
  expect(second).toBe(authorityPath(realpathSync(secondHome), f.worktree))
  expect(second).not.toBe(first)
})

test("Darwin account lookup uses bounded public id, plist dscl and stdin plutil requests", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os home with spaces")
  const expected = createAuthority(osHome, f.worktree)
  const plist = "<plist><dict>plist input is bounded and passed only to plutil</dict></plist>"
  const accountName = "safe_$@user"
  const lookup = stubOSIdentity(osHome, currentUID(), { platform: "darwin", accountName, dsclOutput: plist })

  expect(executionRunDirectory(f.worktree)).toBe(realpathSync(expected))
  const options = { encoding: "utf8", env: { LC_ALL: "C" }, cwd: "/", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16384 }
  const ignoredStdin = { ...options, stdio: ["ignore", "pipe", "pipe"] }
  const pipedStdin = { ...options, stdio: ["pipe", "pipe", "pipe"], input: plist }
  expect(lookup.command).toHaveBeenNthCalledWith(1, "/usr/bin/id", ["-un"], ignoredStdin)
  expect(lookup.command).toHaveBeenNthCalledWith(2, "/usr/bin/dscl", ["-plist", "/Search", "-read", `/Users/${accountName}`, "UniqueID", "NFSHomeDirectory"], ignoredStdin)
  expect(lookup.command).toHaveBeenNthCalledWith(3, "/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], pipedStdin)
  expect(lookup.effectiveUID).toHaveBeenCalledTimes(1)
})

test("Linux account lookup accepts one matching public passwd record", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const expected = createAuthority(osHome, f.worktree)
  const uid = currentUID()
  const lookup = stubOSIdentity(osHome, uid, { platform: "linux" })

  expect(executionRunDirectory(f.worktree)).toBe(realpathSync(expected))
  expect(lookup.command).toHaveBeenCalledTimes(1)
  expect(lookup.command).toHaveBeenCalledWith("/usr/bin/getent", ["passwd", String(uid)], {
    encoding: "utf8", env: { LC_ALL: "C" }, cwd: "/", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16384,
    stdio: ["ignore", "pipe", "pipe"],
  })
})

test("unsupported platforms and native lookup failures use one fixed diagnostic", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  mkdirSync(osHome)
  const unsupported = stubOSIdentity(osHome, currentUID(), { platform: "win32" })
  expect(() => executionRunDirectory(f.worktree)).toThrow("cannot establish trusted operating-system account identity for execution authority")
  expect(unsupported.command).not.toHaveBeenCalled()

  const failure = new Error("private command output must not escape")
  const failed = stubOSIdentity(osHome, currentUID(), { platform: "linux", commandError: failure })
  try {
    let message = ""
    try { executionRunDirectory(f.worktree) }
    catch (error) { message = error instanceof Error ? error.message : String(error) }
    expect(message).toBe("cannot establish trusted operating-system account identity for execution authority")
    expect(message).not.toContain("private command output")
    expect(failed.command).toHaveBeenCalledTimes(1)
  } finally {
    restoreAccountLookup?.()
    restoreAccountLookup = undefined
  }
})

test("malformed Darwin account names, directory-service records, UID and homes fail closed", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  mkdirSync(osHome)
  const uid = currentUID()
  const invalidRecords: AccountLookupOptions[] = [
    { platform: "darwin", idOutput: "name/with/slash\n" },
    { platform: "darwin", idOutput: "name\ncontinued\n" },
    { platform: "darwin", plutilJsonOutput: `{"dsAttrTypeStandard:UniqueID":["${uid + 1}"],"dsAttrTypeStandard:NFSHomeDirectory":["${osHome}"]}` },
    { platform: "darwin", plutilJsonOutput: `{"dsAttrTypeStandard:UniqueID":["${uid}"],"dsAttrTypeStandard:NFSHomeDirectory":["${osHome}"],"unexpected":[]}` },
    { platform: "darwin", plutilJsonOutput: `{"dsAttrTypeStandard:UniqueID":["${uid}"],"dsAttrTypeStandard:NFSHomeDirectory":["relative-home"]}` },
    { platform: "darwin", plutilJsonOutput: `{"dsAttrTypeStandard:UniqueID":["${uid}"],"dsAttrTypeStandard:UniqueID":["${uid}"],"dsAttrTypeStandard:NFSHomeDirectory":["${osHome}"]}` },
    { platform: "darwin", plutilJsonOutput: `{"dsAttrTypeStandard:UniqueID":["${uid}","${uid}"],"dsAttrTypeStandard:NFSHomeDirectory":["${osHome}"]}` },
    { platform: "darwin", plutilJsonOutput: `{"dsAttrTypeStandard:UniqueID":["${uid}"],"dsAttrTypeStandard:NFSHomeDirectory":["${osHome}","/another/home"]}` },
    { platform: "darwin", plutilJsonOutput: "not JSON" },
  ]

  for (const options of invalidRecords) {
    stubOSIdentity(osHome, uid, options)
    expect(() => executionRunDirectory(f.worktree)).toThrow("cannot establish trusted operating-system account identity for execution authority")
  }
})

test("malformed Linux passwd records, duplicate results, UID and homes fail closed", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  mkdirSync(osHome)
  const uid = currentUID()
  const invalidRecords: AccountLookupOptions[] = [
    { platform: "linux", passwdOutput: `user:x:${uid}:20:gecos:${osHome}\nsecond:x:${uid}:20:gecos:${osHome}:/bin/sh\n` },
    { platform: "linux", passwdOutput: `user:x:${uid + 1}:20:gecos:${osHome}:/bin/sh\n` },
    { platform: "linux", passwdOutput: `user:x:${uid}:20:gecos:relative-home:/bin/sh\n` },
    { platform: "linux", passwdOutput: `user:x:${uid}:20:gecos:${osHome}\n` },
  ]

  for (const options of invalidRecords) {
    stubOSIdentity(osHome, uid, options)
    expect(() => executionRunDirectory(f.worktree)).toThrow("cannot establish trusted operating-system account identity for execution authority")
  }
})

test("worktree and OS-home symlink aliases resolve the same canonical authority", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const homeAlias = join(f.root, "os-home-alias")
  const worktreeAlias = join(f.root, "worktree-alias")
  const expected = createAuthority(osHome, f.worktree)
  symlinkSync(osHome, homeAlias, "dir")
  symlinkSync(f.worktree, worktreeAlias, "dir")
  stubOSIdentity(homeAlias)
  setStateEnv({ XDG_STATE_HOME: join(f.root, "legacy-state") })

  const canonicalAuthority = realpathSync(expected)
  expect(executionRunDirectory(f.worktree)).toBe(canonicalAuthority)
  expect(executionRunDirectory(worktreeAlias)).toBe(canonicalAuthority)
  expect(worktreeKey(worktreeAlias)).toBe(worktreeKey(f.worktree))
})

test("external authority aliases are canonicalized while aliases into the worktree are refused", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const selected = authorityPath(osHome, f.worktree)
  const target = join(f.root, "authority-target")
  mkdirSync(target, { recursive: true })
  mkdirSync(join(selected, ".."), { recursive: true })
  symlinkSync(target, selected, "dir")
  stubOSIdentity(osHome)
  setStateEnv({ XDG_STATE_HOME: join(f.root, "legacy-state") })
  expect(executionRunDirectory(f.worktree)).toBe(realpathSync(target))

  const insideTarget = join(f.worktree, "authority-target")
  mkdirSync(insideTarget)
  rmSync(selected)
  symlinkSync(insideTarget, selected, "dir")
  expect(() => executionRunDirectory(f.worktree)).toThrow("resolves inside the worktree")
})

test("foreign worktree UID and invalid OS identities fail closed", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const selected = createAuthority(osHome, f.worktree)
  writeFileSync(join(selected, "preserve.bin"), "unchanged\n")
  stubOSIdentity(osHome, currentUID() === 0 ? 1 : 0)
  setStateEnv({ XDG_STATE_HOME: join(f.root, "legacy-state") })
  const before = readFileSync(join(selected, "preserve.bin"))
  expect(() => executionRunDirectory(f.worktree)).toThrow("worktree is owned by a different operating-system user")
  expect(readFileSync(join(selected, "preserve.bin")).equals(before)).toBe(true)

  stubOSIdentity("relative-home", -1)
  expect(() => executionRunDirectory(f.worktree)).toThrow("cannot establish trusted operating-system account identity")
})

test("an existing authority owned by another UID is refused without mutation", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const selected = createAuthority(osHome, f.worktree)
  const record = join(selected, "state.json")
  writeFileSync(record, "preserved authority")
  stubOSIdentity(osHome)
  setStateEnv({ OTTER_STATE_HOME: join(f.root, "legacy-state") })
  const worktreeStat = fs.statSync(realpathSync(f.worktree))
  const homeStat = fs.statSync(realpathSync(osHome))
  const authorityStat = fs.statSync(realpathSync(selected))
  Object.defineProperty(authorityStat, "uid", { value: currentUID() === 0 ? 1 : 0 })
  const stat = spyOn(fs, "statSync")
    .mockReturnValueOnce(worktreeStat)
    .mockReturnValueOnce(homeStat)
    .mockReturnValueOnce(authorityStat)
  try {
    expect(() => executionRunDirectory(f.worktree)).toThrow("fixed execution authority is owned by a different")
  } finally {
    stat.mockRestore()
  }
  expect(readFileSync(record, "utf8")).toBe("preserved authority")
})

test("missing authority resolves without writes and worktree-contained authority is refused", () => {
  envSnapshot()
  const f = fixture()
  const missingHome = join(f.root, "missing-home")
  mkdirSync(missingHome)
  stubOSIdentity(missingHome)
  setStateEnv({ XDG_STATE_HOME: join(f.root, "legacy-state") })
  const missing = authorityPath(missingHome, f.worktree)
  expect(executionRunDirectory(f.worktree)).toBe(join(realpathSync(missingHome), ".local", "state", "otter", worktreeKey(f.worktree), "execution-runs"))
  expect(() => lstatSync(missing)).toThrow()
  expect(readdirSync(missingHome)).toEqual([])
  expect(readdirSync(f.root).sort()).toEqual(["missing-home", "worktree"])

  const insideHome = join(f.worktree, "os-home")
  const inside = createAuthority(insideHome, f.worktree)
  stubOSIdentity(insideHome)
  expect(() => executionRunDirectory(f.worktree)).toThrow("resolves inside the worktree")
  expect(lstatSync(inside).isDirectory()).toBe(true)
})

test("missing authority beneath a symlinked ancestor is checked against its canonical location", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const authorityParent = join(osHome, ".local", "state", "otter")
  const inside = join(f.worktree, "aliased-authority")
  mkdirSync(authorityParent, { recursive: true })
  mkdirSync(inside)
  symlinkSync(inside, join(authorityParent, worktreeKey(f.worktree)), "dir")
  stubOSIdentity(osHome)
  setStateEnv({ OTTER_STATE_HOME: join(f.root, "legacy-state") })

  expect(() => executionRunDirectory(f.worktree)).toThrow("resolves inside the worktree")
  expect(readdirSync(inside)).toEqual([])
})

test("existing distinct legacy directories and dangling links are refused and preserved", () => {
  envSnapshot()
  for (const kind of ["populated", "empty", "dangling"] as const) {
    const f = fixture()
    const osHome = join(f.root, "os-home")
    const selected = createAuthority(osHome, f.worktree)
    const legacyBase = join(f.root, "configured-state")
    setStateEnv({ OTTER_STATE_HOME: legacyBase })
    stubOSIdentity(osHome)
    const legacy = join(stateRoot(f.worktree), "execution-runs")
    mkdirSync(join(legacy, ".."), { recursive: true })
    let bytes: Buffer | undefined
    const target = join(f.root, "missing-legacy-target")
    if (kind === "populated") {
      mkdirSync(legacy)
      bytes = Buffer.from("legacy evidence\n")
      writeFileSync(join(legacy, "record.json"), bytes)
    } else if (kind === "empty") {
      mkdirSync(legacy)
    } else {
      symlinkSync(target, legacy)
    }

    expect(() => executionRunDirectory(f.worktree)).toThrow()
    expect(lstatSync(legacy).isSymbolicLink()).toBe(kind === "dangling")
    if (kind === "populated") expect(readFileSync(join(legacy, "record.json")).equals(bytes!)).toBe(true)
    if (kind === "empty") expect(readdirSync(legacy)).toEqual([])
    if (kind === "dangling") expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
    expect(lstatSync(selected).isDirectory()).toBe(true)
  }
})

test("same-physical-default legacy authority is accepted and left untouched", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const selected = createAuthority(osHome, f.worktree)
  const preserved = Buffer.from("existing execution authority bytes\n")
  writeFileSync(join(selected, "state.json"), preserved)
  stubOSIdentity(osHome)
  setStateEnv({ HOME: join(f.root, "different-home"), XDG_STATE_HOME: join(osHome, ".local", "state") })

  expect(realpathSync(join(stateRoot(f.worktree), "execution-runs"))).toBe(realpathSync(selected))
  expect(executionRunDirectory(f.worktree)).toBe(realpathSync(selected))
  expect(readFileSync(join(selected, "state.json")).equals(preserved)).toBe(true)
})

test("legacy inspection errors other than ENOENT are not treated as absence", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  createAuthority(osHome, f.worktree)
  const invalidLegacyParent = join(f.root, "legacy-parent-file")
  writeFileSync(invalidLegacyParent, "not a directory")
  setStateEnv({ OTTER_STATE_HOME: invalidLegacyParent })
  stubOSIdentity(osHome)

  expect(() => executionRunDirectory(f.worktree)).toThrow("cannot inspect the configured legacy execution authority")
})

test("existing non-directory and dangling authority entries fail closed", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const candidate = authorityPath(osHome, f.worktree)
  mkdirSync(join(candidate, ".."), { recursive: true })
  stubOSIdentity(osHome)
  setStateEnv({ OTTER_STATE_HOME: join(f.root, "legacy-state") })

  writeFileSync(candidate, "not a directory")
  expect(() => executionRunDirectory(f.worktree)).toThrow("not a directory")
  expect(readFileSync(candidate, "utf8")).toBe("not a directory")
  rmSync(candidate)

  symlinkSync(join(f.root, "dangling-authority-target"), candidate, "dir")
  expect(() => executionRunDirectory(f.worktree)).toThrow()
  expect(lstatSync(candidate).isSymbolicLink()).toBe(true)
  rmSync(candidate)
  const targetFile = join(f.root, "authority-target-file")
  writeFileSync(targetFile, "preserved target")
  symlinkSync(targetFile, candidate)
  expect(() => executionRunDirectory(f.worktree)).toThrow("fixed execution authority is not a directory")
  expect(readFileSync(targetFile, "utf8")).toBe("preserved target")
})

test("missing OS homes, non-directory homes, and malformed home metadata fail closed", () => {
  envSnapshot()
  const f = fixture()
  const missingHome = join(f.root, "missing-home")
  stubOSIdentity(missingHome)
  setStateEnv({ OTTER_STATE_HOME: join(f.root, "legacy-state") })
  expect(() => executionRunDirectory(f.worktree)).toThrow("operating-system home does not exist")

  const fileHome = join(f.root, "file-home")
  writeFileSync(fileHome, "not a directory")
  stubOSIdentity(fileHome)
  expect(() => executionRunDirectory(f.worktree)).toThrow("operating-system home is not a directory")

  stubOSIdentity("relative-home")
  expect(() => executionRunDirectory(f.worktree)).toThrow("cannot establish trusted operating-system account identity")
})

test("dangling symlink and non-directory ancestors cannot be treated as absent authority", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  const keyPath = join(osHome, ".local", "state", "otter", worktreeKey(f.worktree))
  mkdirSync(join(keyPath, ".."), { recursive: true })
  stubOSIdentity(osHome)
  setStateEnv({ OTTER_STATE_HOME: join(f.root, "legacy-state") })

  const danglingTarget = join(f.root, "missing-authority-parent")
  symlinkSync(danglingTarget, keyPath, "dir")
  expect(() => executionRunDirectory(f.worktree)).toThrow()
  rmSync(keyPath)

  writeFileSync(keyPath, "not a directory")
  expect(() => executionRunDirectory(f.worktree)).toThrow()
  expect(readFileSync(keyPath, "utf8")).toBe("not a directory")
})

test("missing and non-directory worktrees cannot acquire an authority namespace", () => {
  envSnapshot()
  const f = fixture()
  const osHome = join(f.root, "os-home")
  mkdirSync(osHome)
  stubOSIdentity(osHome)
  setStateEnv({ OTTER_STATE_HOME: join(f.root, "legacy-state") })
  expect(() => executionRunDirectory(join(f.root, "missing-worktree"))).toThrow("cannot canonicalize")
  const file = join(f.root, "worktree-file")
  writeFileSync(file, "preserved worktree candidate")
  expect(() => executionRunDirectory(file)).toThrow("worktree is not a directory")
  expect(readFileSync(file, "utf8")).toBe("preserved worktree candidate")
  expect(readdirSync(osHome)).toEqual([])
})
