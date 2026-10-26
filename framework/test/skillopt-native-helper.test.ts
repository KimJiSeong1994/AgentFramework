import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { buildSkillOptNativeHelper } from "../src/skillopt/native-helper.ts"

const canBuildNativeHelper = process.platform === "darwin" || process.platform === "linux"

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

function requirePosixUid(): number {
  if (!canBuildNativeHelper || typeof process.getuid !== "function") {
    throw new Error("native helper validation requires a POSIX process uid")
  }
  return process.getuid()
}

test.skipIf(!canBuildNativeHelper)("builds the bundled source with the fixed system compiler and validates its actual native clock", () => {
  const uid = requirePosixUid()
  const originalCC = process.env.CC
  process.env.CC = "/untrusted/compiler-from-environment"
  let built: ReturnType<typeof buildSkillOptNativeHelper> | undefined
  try {
    built = buildSkillOptNativeHelper()
    const sourcePath = realpathSync.native(resolve(import.meta.dir, "../src/skillopt/native.c"))
    const compilerPath = realpathSync.native("/usr/bin/cc")
    const helperStat = lstatSync(built.helper.nativeHelperPath)
    expect(built.sourcePath).toBe(sourcePath)
    expect(built.sourceSha256).toBe(sha256(readFileSync(sourcePath)))
    expect(built.compilerPath).toBe(compilerPath)
    const compilerStat = lstatSync(compilerPath)
    expect(compilerStat.isFile()).toBe(true)
    expect(compilerStat.uid).toBe(0)
    expect(compilerStat.mode & 0o022).toBe(0)
    expect(built.compilerSha256).toBe(sha256(readFileSync(compilerPath)))
    expect(built.helper.nativeHelperSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(built.clock).toMatchObject({ protocol: "skillopt-promotion.v3", platform: process.platform })
    expect(Object.keys(built.clock).sort()).toEqual(["bootId", "continuousNanoseconds", "platform", "protocol", "wallMilliseconds"])
    expect(built.clock.bootId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u)
    expect(BigInt(built.clock.continuousNanoseconds)).toBeGreaterThan(0n)
    expect(BigInt(built.clock.wallMilliseconds)).toBeGreaterThan(0n)
    expect(helperStat.isFile()).toBe(true)
    expect(helperStat.isSymbolicLink()).toBe(false)
    expect(helperStat.uid).toBe(uid)
    expect(helperStat.nlink).toBe(1)
    expect(helperStat.mode & 0o777).toBe(0o700)
    expect(sha256(readFileSync(built.helper.nativeHelperPath))).toBe(built.helper.nativeHelperSha256)
    const privateDirectory = dirname(built.helper.nativeHelperPath)
    const directoryStat = lstatSync(privateDirectory)
    expect(directoryStat.isDirectory()).toBe(true)
    expect(directoryStat.uid).toBe(uid)
    expect(directoryStat.mode & 0o777).toBe(0o700)
    built.dispose()
    expect(existsSync(built.helper.nativeHelperPath)).toBe(false)
    expect(existsSync(privateDirectory)).toBe(false)
  } finally {
    try { built?.dispose() } catch { /* Preserve unexpected cleanup drift for the assertion path. */ }
    if (originalCC === undefined) delete process.env.CC
    else process.env.CC = originalCC
  }
})

test("rejects caller-controlled compiler, source, and expected-hash inputs", () => {
  const inject = buildSkillOptNativeHelper as unknown as (...args: unknown[]) => unknown
  expect(() => inject({
    compilerPath: "/tmp/attacker-compiler",
    sourcePath: "/tmp/attacker.c",
    expectedSha256: "0".repeat(64),
  })).toThrow("native-helper-provider:caller-input-forbidden")
})

test.skipIf(!canBuildNativeHelper)("helper disposal unlinks only its own binary and never recursively removes private-directory contents", () => {
  const uid = requirePosixUid()
  const built = buildSkillOptNativeHelper()
  const privateDirectory = dirname(built.helper.nativeHelperPath)
  const unrelated = join(privateDirectory, "keep-me")
  writeFileSync(unrelated, "unrelated private data\n", { flag: "wx", mode: 0o600 })
  try {
    expect(() => built.dispose()).toThrow("native-helper-provider:cleanup-directory-not-empty-or-changed")
    expect(existsSync(built.helper.nativeHelperPath)).toBe(false)
    expect(readFileSync(unrelated, "utf8")).toBe("unrelated private data\n")
    expect(lstatSync(privateDirectory).mode & 0o777).toBe(0o700)
    expect(lstatSync(privateDirectory).uid).toBe(uid)
    unlinkSync(unrelated)
    built.dispose()
    expect(existsSync(privateDirectory)).toBe(false)
  } finally {
    if (existsSync(unrelated)) unlinkSync(unrelated)
    if (existsSync(privateDirectory) && !existsSync(built.helper.nativeHelperPath)) rmdirSync(privateDirectory)
  }
})
