import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { randomBytes } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { executionRunDirectory } from "../src/state/store.ts"
import { tempExecutionAuthority, tempGitWorktree, tempWorktree, type TempExecutionAuthority } from "./guards-helpers.ts"

type Identity = { uid: bigint; dev: bigint; ino: bigint }

type WorktreeFixture = { root: string; worktree: string; cleanup: () => void }

function freshWorktree(): WorktreeFixture {
  const root = mkdtempSync(join(tmpdir(), "lca-execution-authority-fixture-"))
  const worktree = join(root, "worktree")
  mkdirSync(worktree)
  return { root, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true })
  return { uid: stat.uid, dev: stat.dev, ino: stat.ino }
}

function hasIdentity(path: string, expected: Identity, kind: "directory" | "file"): boolean {
  try {
    const stat = lstatSync(path, { bigint: true })
    return (kind === "directory" ? stat.isDirectory() : stat.isFile()) &&
      stat.uid === expected.uid && stat.dev === expected.dev && stat.ino === expected.ino
  } catch {
    return false
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

function releaseOrThrow(authority: TempExecutionAuthority): void {
  const result = authority.release({ preserve: false })
  if (!result.removed) throw new Error(`fixture namespace retained at ${result.path}: ${result.reason ?? "release did not remove it"}`)
}

function effectiveUID(): number {
  const uid = process.geteuid?.()
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("test requires a valid effective operating-system UID")
  }
  return uid
}

function expectActualAuthority(worktree: string, directory: string): void {
  expect(directory).toBe(executionRunDirectory(worktree))
  const uid = BigInt(effectiveUID())
  expect(lstatSync(worktree, { bigint: true }).uid).toBe(uid)
  expect(lstatSync(directory, { bigint: true }).uid).toBe(uid)
}

function markerPath(directory: string): string {
  const entries = readdirSync(directory)
  expect(entries).toHaveLength(1)
  return join(directory, entries[0]!)
}

test("fixture allocation refuses an existing namespace without changing its bytes", () => {
  const fixture = freshWorktree()
  const envKeys = ["HOME", "XDG_STATE_HOME", "LCA_STATE_HOME"] as const
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]])) as Record<typeof envKeys[number], string | undefined>
  let authority: TempExecutionAuthority | undefined
  try {
    authority = tempExecutionAuthority(fixture.worktree)
    expectActualAuthority(fixture.worktree, authority.directory)
    expect(Object.isFrozen(authority)).toBe(true)
    expect(authority.keyDirectory).toBe(dirname(authority.directory))

    const marker = markerPath(authority.directory)
    const keyBefore = identity(authority.keyDirectory)
    const directoryBefore = identity(authority.directory)
    const markerBefore = identity(marker)
    const bytesBefore = readFileSync(marker)
    expect(keyBefore.uid).toBe(BigInt(effectiveUID()))
    expect(directoryBefore.uid).toBe(keyBefore.uid)
    expect(markerBefore.uid).toBe(keyBefore.uid)
    expect(lstatSync(marker).isFile()).toBe(true)

    const envOverrides: Array<Partial<Record<typeof envKeys[number], string>>> = [
      { HOME: join(fixture.root, "home-one"), XDG_STATE_HOME: join(fixture.root, "xdg-one") },
      { HOME: join(fixture.root, "home-two"), XDG_STATE_HOME: join(fixture.root, "xdg-two") },
      { HOME: join(fixture.root, "home-three"), XDG_STATE_HOME: join(fixture.root, "xdg-three"), LCA_STATE_HOME: join(fixture.root, "lca-three") },
    ]
    for (const overrides of envOverrides) {
      for (const key of envKeys) {
        const value = overrides[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      expectActualAuthority(fixture.worktree, authority.directory)
      expect(() => tempExecutionAuthority(fixture.worktree)).toThrow("already exists and was not adopted or changed")

      expect(readdirSync(authority.directory)).toEqual([marker.slice(authority.directory.length + 1)])
      expect(identity(authority.keyDirectory)).toEqual(keyBefore)
      expect(identity(authority.directory)).toEqual(directoryBefore)
      expect(identity(marker)).toEqual(markerBefore)
      expect(readFileSync(marker).equals(bytesBefore)).toBe(true)
    }
  } finally {
    try {
      if (authority) releaseOrThrow(authority)
    } finally {
      for (const key of envKeys) {
        const value = savedEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fixture.cleanup()
    }
  }
})

test("preserve release leaves the namespace untouched and normal release retains the shared base", () => {
  const fixture = freshWorktree()
  let authority: TempExecutionAuthority | undefined
  try {
    authority = tempExecutionAuthority(fixture.worktree)
    expectActualAuthority(fixture.worktree, authority.directory)

    const marker = markerPath(authority.directory)
    const keyBefore = identity(authority.keyDirectory)
    const directoryBefore = identity(authority.directory)
    const markerBefore = identity(marker)
    const bytesBefore = readFileSync(marker)
    const base = dirname(authority.keyDirectory)
    const keyDirectory = authority.keyDirectory
    const baseBefore = identity(base)

    const preserved = authority.release({ preserve: true })
    expect(preserved.removed).toBe(false)
    expect(preserved.path).toBe(authority.keyDirectory)
    expect(preserved.reason).toContain("preserved")
    expect(identity(authority.keyDirectory)).toEqual(keyBefore)
    expect(identity(authority.directory)).toEqual(directoryBefore)
    expect(identity(marker)).toEqual(markerBefore)
    expect(readFileSync(marker).equals(bytesBefore)).toBe(true)

    rmSync(fixture.worktree, { recursive: true })
    const removed = authority.release({ preserve: false })
    expect(removed.removed).toBe(true)
    expect(removed.path).toBe(keyDirectory)
    authority = undefined
    expect(() => lstatSync(keyDirectory)).toThrow()
    expect(identity(base)).toEqual(baseBefore)
    expect(lstatSync(base).isDirectory()).toBe(true)
  } finally {
    try {
      if (authority) releaseOrThrow(authority)
    } finally {
      fixture.cleanup()
    }
  }
})

test("content drift is retained until the captured marker is restored", () => {
  const fixture = freshWorktree()
  let authority: TempExecutionAuthority | undefined
  let marker: string | undefined
  let originalMarker: Buffer | undefined
  let originalMarkerIdentity: Identity | undefined
  try {
    authority = tempExecutionAuthority(fixture.worktree)
    expectActualAuthority(fixture.worktree, authority.directory)
    marker = markerPath(authority.directory)
    originalMarker = readFileSync(marker)
    originalMarkerIdentity = identity(marker)

    writeFileSync(marker, Buffer.from("deliberate fixture marker drift\n"))
    const retained = authority.release({ preserve: false })
    expect(retained.removed).toBe(false)
    expect(retained.path).toBe(authority.keyDirectory)
    expect(retained.reason).toContain("marker content changed")
    expect(lstatSync(authority.keyDirectory).isDirectory()).toBe(true)

    expect(hasIdentity(marker, originalMarkerIdentity, "file")).toBe(true)
    writeFileSync(marker, originalMarker)
    expect(readFileSync(marker).equals(originalMarker)).toBe(true)
    releaseOrThrow(authority)
    authority = undefined
  } finally {
    try {
      if (authority && marker && originalMarker && originalMarkerIdentity && hasIdentity(marker, originalMarkerIdentity, "file")) {
        writeFileSync(marker, originalMarker)
      }
      if (authority) releaseOrThrow(authority)
    } finally {
      fixture.cleanup()
    }
  }
})

test("repeated release never removes a subsequently allocated namespace", () => {
  const fixture = freshWorktree()
  let first: TempExecutionAuthority | undefined
  let second: TempExecutionAuthority | undefined
  try {
    first = tempExecutionAuthority(fixture.worktree)
    releaseOrThrow(first)
    second = tempExecutionAuthority(fixture.worktree)
    const marker = markerPath(second.directory)
    const before = readFileSync(marker)
    const keyIdentity = identity(second.keyDirectory)
    expect(first.release({ preserve: false }).removed).toBe(true)
    expect(identity(second.keyDirectory)).toEqual(keyIdentity)
    expect(readFileSync(marker).equals(before)).toBe(true)
  } finally {
    try {
      if (first) releaseOrThrow(first)
      if (second) releaseOrThrow(second)
    } finally {
      fixture.cleanup()
    }
  }
})

test("directory identity drift is retained and can be safely restored by its test owner", () => {
  const fixture = freshWorktree()
  let authority: TempExecutionAuthority | undefined
  let originalDirectoryIdentity: Identity | undefined
  let replacementDirectoryIdentity: Identity | undefined
  let backup: string | undefined
  let movedOriginal = false
  try {
    authority = tempExecutionAuthority(fixture.worktree)
    expectActualAuthority(fixture.worktree, authority.directory)
    originalDirectoryIdentity = identity(authority.directory)
    backup = join(authority.keyDirectory, `.fixture-original-${randomBytes(24).toString("hex")}`)
    expect(() => lstatSync(backup!)).toThrow()

    renameSync(authority.directory, backup)
    movedOriginal = true
    mkdirSync(authority.directory, { mode: 0o700 })
    replacementDirectoryIdentity = identity(authority.directory)

    const retained = authority.release({ preserve: false })
    expect(retained.removed).toBe(false)
    expect(retained.path).toBe(authority.keyDirectory)
    expect(retained.reason).toContain("captured directory identity changed")
    expect(hasIdentity(authority.directory, replacementDirectoryIdentity, "directory")).toBe(true)
    expect(hasIdentity(backup, originalDirectoryIdentity, "directory")).toBe(true)
  } finally {
    try {
      if (authority && originalDirectoryIdentity && backup) {
        if (replacementDirectoryIdentity) {
          if (hasIdentity(authority.directory, replacementDirectoryIdentity, "directory")) {
            if (readdirSync(authority.directory).length !== 0) {
              throw new Error(`cannot safely remove nonempty test replacement at ${authority.directory}; preserved namespace: ${authority.keyDirectory}`)
            }
            rmdirSync(authority.directory)
          } else if (pathExists(authority.directory)) {
            throw new Error(`cannot safely restore over an unexpected execution directory; preserved namespace: ${authority.keyDirectory}`)
          }
        } else if (movedOriginal ? pathExists(authority.directory) : !hasIdentity(authority.directory, originalDirectoryIdentity, "directory")) {
          throw new Error(`cannot safely restore test-owned execution directory; preserved namespace: ${authority.keyDirectory}`)
        }

        if (movedOriginal) {
          if (!hasIdentity(backup, originalDirectoryIdentity, "directory")) {
            throw new Error(`captured execution directory was not found at its test backup; preserved namespace: ${authority.keyDirectory}`)
          }
          renameSync(backup, authority.directory)
        }
        if (!hasIdentity(authority.directory, originalDirectoryIdentity, "directory")) {
          throw new Error(`captured execution directory identity was not restored; preserved namespace: ${authority.keyDirectory}`)
        }
      }
      if (authority) releaseOrThrow(authority)
    } finally {
      fixture.cleanup()
    }
  }
})


test("temp worktree restores absent and prior LCA_STATE_HOME values", () => {
  const previous = process.env.LCA_STATE_HOME
  const fixtures: ReturnType<typeof tempWorktree>[] = []
  try {
    delete process.env.LCA_STATE_HOME
    const absent = tempWorktree()
    fixtures.push(absent)
    expect(String(process.env.LCA_STATE_HOME)).toBe(absent.stateHome)
    absent.cleanup()
    expect(process.env.LCA_STATE_HOME).toBeUndefined()

    process.env.LCA_STATE_HOME = "prior-state-home"
    const valued = tempWorktree()
    fixtures.push(valued)
    expect(String(process.env.LCA_STATE_HOME)).toBe(valued.stateHome)
    valued.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("prior-state-home")
  } finally {
    for (const fixture of fixtures.reverse()) fixture.cleanup()
    if (previous === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = previous
  }
})

test("nested temp worktrees restore in LIFO and out-of-order cleanup skips closed fixtures", () => {
  const previous = process.env.LCA_STATE_HOME
  const fixtures: ReturnType<typeof tempWorktree>[] = []
  try {
    process.env.LCA_STATE_HOME = "original-state-home"
    const first = tempWorktree(); fixtures.push(first)
    const second = tempWorktree(); fixtures.push(second)
    second.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe(first.stateHome)
    first.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("original-state-home")

    const a = tempWorktree(); fixtures.push(a)
    const b = tempWorktree(); fixtures.push(b)
    a.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe(b.stateHome)
    b.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("original-state-home")
  } finally {
    for (const fixture of fixtures.reverse()) fixture.cleanup()
    if (previous === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = previous
  }
})

test("external state home between live fixtures is restored and independent cleanup is safe", () => {
  const previous = process.env.LCA_STATE_HOME
  const fixtures: ReturnType<typeof tempWorktree>[] = []
  try {
    process.env.LCA_STATE_HOME = "root-state-home"
    const a = tempWorktree(); fixtures.push(a)
    process.env.LCA_STATE_HOME = "external-state-home"
    const b = tempWorktree(); fixtures.push(b)
    expect(String(process.env.LCA_STATE_HOME)).toBe(b.stateHome)
    b.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("external-state-home")
    a.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("external-state-home")

    process.env.LCA_STATE_HOME = "root-state-home"
    const c = tempWorktree(); fixtures.push(c)
    const d = tempWorktree(); fixtures.push(d)
    c.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe(d.stateHome)
    d.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("root-state-home")
  } finally {
    for (const fixture of fixtures.reverse()) fixture.cleanup()
    if (previous === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = previous
  }
})

test("temp worktree cleanup preserves unrelated replacement and is idempotent", () => {
  const previous = process.env.LCA_STATE_HOME
  let fixture: ReturnType<typeof tempWorktree> | undefined
  try {
    delete process.env.LCA_STATE_HOME
    fixture = tempWorktree()
    process.env.LCA_STATE_HOME = "unrelated-later-selection"
    fixture.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("unrelated-later-selection")
    process.env.LCA_STATE_HOME = "another-later-selection"
    fixture.cleanup()
    expect(String(process.env.LCA_STATE_HOME)).toBe("another-later-selection")
  } finally {
    fixture?.cleanup()
    if (previous === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = previous
  }
})

test("cleanup refusal restores environment but retains fixture paths and diagnostics", () => {
  const previous = process.env.LCA_STATE_HOME
  let fixture: ReturnType<typeof tempWorktree> | undefined
  let marker: string | undefined
  let markerBytes: Buffer | undefined
  try {
    process.env.LCA_STATE_HOME = "prior-state-home"
    fixture = tempWorktree()
    marker = markerPath(fixture.executionAuthority.directory)
    markerBytes = readFileSync(marker)
    writeFileSync(marker, Buffer.from("deliberate marker drift\n"))

    let diagnostic = ""
    try { fixture.cleanup() } catch (error) { diagnostic = error instanceof Error ? error.message : String(error) }
    expect(diagnostic).toContain(`execution authority retained at ${fixture.executionAuthority.keyDirectory}`)
    expect(diagnostic).toContain(`worktree retained at ${fixture.worktree}`)
    expect(diagnostic).toContain(`stateHome retained at ${fixture.stateHome}`)
    expect(String(process.env.LCA_STATE_HOME)).toBe("prior-state-home")
    expect(pathExists(fixture.stateHome)).toBe(true)
    expect(pathExists(fixture.executionAuthority.keyDirectory)).toBe(true)
  } finally {
    if (fixture && marker && markerBytes && pathExists(marker)) writeFileSync(marker, markerBytes)
    fixture?.cleanup()
    if (previous === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = previous
  }
})

test("temp worktree setup failure restores environment and reports retained paths", () => {
  const previous = process.env.LCA_STATE_HOME
  const originalMkdirSync = mkdirSync
  const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    if (typeof path === "string" && path.endsWith("execution-runs")) {
      const error = new Error("injected mkdir failure") as NodeJS.ErrnoException
      error.code = "EACCES"
      throw error
    }
    return originalMkdirSync(path, options as never)
  }) as typeof fs.mkdirSync)
  try {
    process.env.LCA_STATE_HOME = "prior-state-home"
    let diagnostic = ""
    try { tempWorktree() } catch (error) { diagnostic = error instanceof Error ? error.message : String(error) }
    expect(diagnostic).toContain("tempWorktree setup failed")
    expect(diagnostic).toContain("worktree retained at")
    expect(diagnostic).toContain("stateHome retained at")
    expect(diagnostic).toContain("retained partial namespace at")
    expect(String(process.env.LCA_STATE_HOME)).toBe("prior-state-home")
  } finally {
    mkdirSpy.mockRestore()
    if (previous === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = previous
  }
})

test("tempGitWorktree initialization failure retains and reports its owned paths", () => {
  const previous = process.env.LCA_STATE_HOME
  try {
    process.env.LCA_STATE_HOME = "prior-state-home"
    let diagnostic = ""
    try { tempGitWorktree({ "missing/parent/file.txt": "cannot create\n" }) }
    catch (error) { diagnostic = error instanceof Error ? error.message : String(error) }
    expect(diagnostic).toContain("tempGitWorktree setup failed")
    expect(diagnostic).toContain("worktree retained at")
    expect(diagnostic).toContain("stateHome retained at")
    expect(diagnostic).toContain("execution-authority namespace retained at")
    expect(String(process.env.LCA_STATE_HOME)).toBe("prior-state-home")
  } finally {
    if (previous === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = previous
  }
})
